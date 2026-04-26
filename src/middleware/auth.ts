import { verifyToken } from '@clerk/backend';
import type { Request, Response, NextFunction } from 'express';

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
    });

    req.auth = {
      userId: payload.sub,
      orgId: (payload as Record<string, unknown>).org_id as string | null ?? null,
    };

    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
