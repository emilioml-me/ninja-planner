pipeline {

    agent {
        docker {
            image 'node:20-alpine'
            // Mount docker socket so we can build/push images from inside the container
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

        stage('Bootstrap') {
            steps {
                // docker-cli + openssh-client not present in node:20-alpine by default
                sh 'apk add --no-cache docker-cli openssh-client'
                sh 'npm ci'
            }
        }

        stage('Full Test Suite') {
            parallel {
                stage('Typecheck') {
                    steps {
                        sh 'npm run typecheck'
                    }
                }
                stage('Backend Tests') {
                    steps {
                        sh 'npm test'
                    }
                }
                stage('Build') {
                    steps {
                        // Build without a real Clerk key — catches TS/Vite errors in CI
                        withEnv(['VITE_CLERK_PUBLISHABLE_KEY=pk_test_ci_placeholder']) {
                            sh 'npm run build'
                        }
                    }
                }
            }
        }

        stage('Pending Migrations') {
            steps {
                echo '━━━ Pending SQL migrations (will be applied automatically on startup) ━━━'
                sh '''
                    echo "Migration files in this release:"
                    ls -1 migrations/*.sql | sort
                '''
                echo '━━━ End of migration list ━━━'
                input(
                    message: 'Review migration list above. Approve to build & deploy?',
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
                                -t ${IMAGE}:${VERSION} \
                                -t ${IMAGE}:latest \
                                .

                            docker push ${IMAGE}:${VERSION}
                            docker push ${IMAGE}:latest
                            echo "✅ Pushed ${IMAGE}:${VERSION} and ${IMAGE}:latest"
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
                // sshagent DSL is unavailable in the node:20-alpine Docker agent.
                // Use withCredentials + manual key file instead.
                withCredentials([sshUserPrivateKey(
                    credentialsId: env.DEPLOY_CRED,
                    keyFileVariable: 'SSH_KEY'
                )]) {
                    sh """
                        chmod 600 ${SSH_KEY}
                        ssh -i ${SSH_KEY} \
                            -o StrictHostKeyChecking=no \
                            -o BatchMode=yes \
                            ubuntu@${DEPLOY_HOST} \
                            'bash /srv/scripts/deploy.sh ${APP_NAME} ${VERSION}'
                    """
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
