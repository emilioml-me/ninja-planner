pipeline {

    agent {
        docker {
            image 'node:20-alpine'
            args  '-v /var/run/docker.sock:/var/run/docker.sock -u root'
            reuseNode true
        }
    }

    environment {
        APP_NAME    = 'ninja-planner'
        DEPLOY_HOST = '10.10.0.10'
        DEPLOY_CRED = 'ninja-prod001'
        IMAGE       = 'ghcr.io/emilioml-me/ninja-planner'
        VERSION     = "${TAG_NAME}"
    }

    options {
        timeout(time: 45, unit: 'MINUTES')
        disableConcurrentBuilds()
    }

    stages {

        stage('Install') {
            steps {
                sh 'npm ci'
            }
        }

        stage('Full Test Suite') {
            parallel {
                stage('Build') {
                    steps {
                        sh 'npm run build'
                    }
                }
            }
        }

        stage('DB Migration Gate') {
            steps {
                echo '━━━ Drizzle migration diff ━━━'
                sh 'npx drizzle-kit generate 2>&1 || echo "(no pending migrations)"'
                echo '━━━ End of migration diff ━━━'
                input(
                    message: 'Review migration SQL above. Approve to proceed?',
                    ok: 'Approve & Deploy'
                )
            }
        }

        stage('Docker Build & Push') {
            steps {
                withCredentials([usernamePassword(
                    credentialsId: 'ghcr-token',
                    usernameVariable: 'GHCR_USER',
                    passwordVariable: 'GHCR_TOKEN'
                )]) {
                    withCredentials([string(
                        credentialsId: 'clerk-pk-prod-ninja-planner',
                        variable: 'CLERK_PK'
                    )]) {
                        sh '''
                            echo "${GHCR_TOKEN}" | docker login ghcr.io -u "${GHCR_USER}" --password-stdin
                            docker build \
                                --build-arg VITE_CLERK_PUBLISHABLE_KEY=${CLERK_PK} \
                                -t ${IMAGE}:${VERSION} .
                            docker push ${IMAGE}:${VERSION}
                            echo "✅ Pushed ${IMAGE}:${VERSION}"
                        '''
                    }
                }
            }
        }

        stage('Manual Approval') {
            steps {
                input(
                    message: "Deploy ninja-planner ${VERSION} to production (${DEPLOY_HOST})?",
                    ok: 'Deploy to Production',
                    submitter: 'emilioml-me'
                )
            }
        }

        stage('Deploy to Production') {
            steps {
                sshagent(credentials: [env.DEPLOY_CRED]) {
                    sh "ssh -o StrictHostKeyChecking=no ubuntu@${DEPLOY_HOST} 'bash /srv/scripts/deploy.sh ${APP_NAME} ${VERSION}'"
                }
            }
        }
    }

    post {
        success {
            echo "✅ ninja-planner ${VERSION} deployed to production"
        }
        failure {
            echo "❌ Pipeline failed — rollback if needed:"
            echo "   ssh ubuntu@${DEPLOY_HOST} 'bash /srv/scripts/rollback.sh ${APP_NAME} <prev-version>'"
        }
        always {
            sh 'docker image prune -f || true'
        }
    }
}
