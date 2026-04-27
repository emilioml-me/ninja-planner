export {};

declare global {
  namespace Express {
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
