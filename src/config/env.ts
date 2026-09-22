// Side-effect module: MUST be the first import in src/index.ts. ESM evaluates static imports
// before the importing module's body, so calling dotenv.config() in index.ts's body ran AFTER
// db.ts/r2.ts/subscriptionService.ts etc. had already read process.env at module load (M35).
import dotenv from 'dotenv';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const REQUIRED_ENV = ['CLERK_SECRET_KEY', 'CLERK_WEBHOOK_SECRET', 'DATABASE_URL'] as const;
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}
if (process.env.NODE_ENV === 'production' && !process.env.ALLOWED_ORIGIN) {
  console.error('Missing required env var: ALLOWED_ORIGIN');
  process.exit(1);
}
