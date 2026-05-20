import { useEffect, useState } from 'react';
import { useAuth, SignIn } from '@clerk/clerk-react';
import { useApiClient } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, CheckCircle2, XCircle, Users } from 'lucide-react';

interface InviteInfo {
  workspace_name: string;
  expires_at: string;
}

interface AcceptResult {
  ok: boolean;
  workspace_id: string;
  clerk_org_id: string;
  already_member: boolean;
}

export default function AcceptInvite({ token }: { token: string }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { apiRequest } = useApiClient();

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState<AcceptResult | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  // Load invite info (public endpoint — no auth needed)
  useEffect(() => {
    // Validate token is a UUID before fetching to guard against path-traversal attempts
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
      setInfoError('Invalid invite link');
      return;
    }
    fetch(`/api/invites/token/${token}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? 'Invite not found or expired');
        }
        return r.json() as Promise<InviteInfo>;
      })
      .then(setInfo)
      .catch((e: Error) => setInfoError(e.message));
  }, [token]);

  const handleAccept = async () => {
    setAccepting(true);
    setAcceptError(null);
    try {
      const result = await apiRequest<AcceptResult>('POST', `/api/invites/token/${token}/accept`);
      setAccepted(result);
    } catch (e: unknown) {
      setAcceptError(e instanceof Error ? e.message : 'Failed to accept invite');
    } finally {
      setAccepting(false);
    }
  };

  // ── Loading invite info ──────────────────────────────────────────────────────
  if (!info && !infoError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // ── Invalid / expired invite ─────────────────────────────────────────────────
  if (infoError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-sm text-center">
          <CardHeader>
            <XCircle className="h-10 w-10 text-destructive mx-auto mb-2" />
            <CardTitle>Invite unavailable</CardTitle>
            <CardDescription>{infoError}</CardDescription>
          </CardHeader>
          <CardFooter className="justify-center">
            <Button variant="outline" onClick={() => window.location.href = '/'}>Go home</Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  // ── Success ──────────────────────────────────────────────────────────────────
  if (accepted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-sm text-center">
          <CardHeader>
            <CheckCircle2 className="h-10 w-10 text-green-500 mx-auto mb-2" />
            <CardTitle>{accepted.already_member ? 'Already a member' : 'Welcome aboard!'}</CardTitle>
            <CardDescription>
              {accepted.already_member
                ? `You're already a member of ${info!.workspace_name}.`
                : `You've joined ${info!.workspace_name}. You can now access the workspace.`}
            </CardDescription>
          </CardHeader>
          <CardFooter className="justify-center">
            <Button onClick={() => window.location.href = '/dashboard'}>
              Open workspace
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  // ── Invite card ──────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <Users className="h-10 w-10 text-primary mx-auto mb-2" />
          <CardTitle>You're invited!</CardTitle>
          <CardDescription>
            Join <strong>{info!.workspace_name}</strong> on Plan Ninja
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground text-center">
            Expires {new Date(info!.expires_at).toLocaleDateString(undefined, {
              month: 'long', day: 'numeric', year: 'numeric',
            })}
          </p>

          {!isLoaded ? (
            <div className="flex justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : !isSignedIn ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground text-center">
                Sign in or create an account to accept this invite.
              </p>
              <SignIn
                appearance={{ elements: { rootBox: 'w-full', card: 'shadow-none border p-4 rounded-lg' } }}
                afterSignInUrl={`/invite/${token}`}
                afterSignUpUrl={`/invite/${token}`}
              />
            </div>
          ) : (
            <>
              {acceptError && (
                <p className="text-sm text-destructive text-center">{acceptError}</p>
              )}
              <Button className="w-full" onClick={handleAccept} disabled={accepting}>
                {accepting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Accept &amp; Join Workspace
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
