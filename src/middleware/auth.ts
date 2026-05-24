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

    // Clerk v2 tokens nest org context under "o.id"; fall back to legacy "org_id"
    const p = payload as Record<string, unknown>;
    const orgObj = p.o as { id?: string } | null | undefined;
    req.auth = {
      userId: payload.sub,
      orgId: orgObj?.id ?? (p.org_id as string | null) ?? null,
      memberRole: null,
    };

    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
