export {};

declare global {
  namespace Express {
    // NOTE: declared non-optional for ergonomics, but only populated on routes behind requireAuth
    // (req.auth) and requireWorkspace*/apiKeyAuth (req.workspace). Public routers (/public,
    // /webhooks, /api/integrations/*/webhook, /health, /api/docs, public invite lookup) must not
    // read them; use optional chaining (req.auth?.userId) in code that can run on both kinds.
    interface Request {
      auth: {
        userId: string;
        orgId: string | null;
        memberRole: string | null;
      };
      workspace: {
        id: string;
        name: string;
        plan: string;
      };
    }
  }
}
