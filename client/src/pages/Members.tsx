import { useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMembers } from '@/hooks/use-members';
import { useApiClient } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, Trash2, Users, Crown, Shield, User, CheckCircle2, Clock, Zap, MessageSquare, TrendingUp, AlertTriangle, Link2, Copy, RefreshCw, X, Eye, UserX } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

interface MemberStats {
  total: number;
  todo: number;
  in_progress: number;
  done: number;
  blocked: number;
  overdue: number;
  sprint_count: number;
  comment_count: number;
  completion_rate: number;
}

const ROLE_META: Record<string, { label: string; icon: React.ElementType; variant: 'default' | 'secondary' | 'outline' }> = {
  owner:  { label: 'Owner',  icon: Crown,  variant: 'default'   },
  admin:  { label: 'Admin',  icon: Shield, variant: 'secondary' },
  member: { label: 'Member', icon: User,   variant: 'outline'   },
  viewer: { label: 'Viewer', icon: Eye,    variant: 'outline'   },
  guest:  { label: 'Guest',  icon: UserX,  variant: 'outline'   },
};

// DB role values are Clerk-style ('org:member', 'org:admin', 'org:owner') plus this app's own
// 'viewer'/'guest' values — normalize before looking up display metadata.
const roleKey = (role: string) => role.replace(/^org:/, '');

export default function Members() {
  const { userId, orgRole } = useAuth();
  const { members, initials, isLoading } = useMembers();
  const { apiRequest } = useApiClient();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [statsTarget, setStatsTarget] = useState<{ clerkUserId: string; name: string; imageUrl: string | null } | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const isAdmin = orgRole === 'org:admin' || orgRole === 'org:owner';

  const removeMutation = useMutation({
    mutationFn: (memberId: string) =>
      apiRequest('DELETE', `/api/workspaces/me/members/${memberId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/workspaces/me/members'] });
      toast({ title: 'Member removed' });
      setConfirmRemoveId(null);
    },
    onError: () => {
      toast({ title: 'Failed to remove member', variant: 'destructive' });
      setConfirmRemoveId(null);
    },
  });

  const confirmTarget = members.find((m) => m.id === confirmRemoveId);

  const roleMutation = useMutation({
    mutationFn: ({ clerkUserId, role }: { clerkUserId: string; role: 'org:member' | 'viewer' }) =>
      apiRequest('PATCH', `/api/workspaces/me/members/${clerkUserId}/role`, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/workspaces/me/members'] });
      toast({ title: 'Role updated' });
    },
    onError: () => toast({ title: 'Failed to update role', variant: 'destructive' }),
  });

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Users className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Team Members</h1>
          <p className="text-sm text-muted-foreground">
            {members.length} member{members.length !== 1 ? 's' : ''} in this workspace
          </p>
        </div>
        {isAdmin && (
          <Button size="sm" className="gap-2" onClick={() => setInviteOpen(true)}>
            <Link2 className="h-4 w-4" /> Invite Link
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workspace members</CardTitle>
          <CardDescription>
            Members are managed through your organisation in Clerk. Only admins can remove members here.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : members.length === 0 ? (
            <div className="text-center py-12 text-sm text-muted-foreground">
              No members found.
            </div>
          ) : (
            <ul className="divide-y">
              {members.map((member) => {
                const rKey = roleKey(member.role);
                const roleMeta = ROLE_META[rKey] ?? ROLE_META.member;
                const RoleIcon = roleMeta.icon;
                const isSelf = member.clerk_user_id === userId;
                const abbr = initials(member.clerk_user_id);
                const isOwnerOrAdmin = rKey === 'owner' || rKey === 'admin';

                return (
                  <li
                    key={member.id}
                    className="flex items-center gap-4 px-6 py-4 hover:bg-muted/40 transition-colors cursor-pointer"
                    onClick={() => setStatsTarget({ clerkUserId: member.clerk_user_id, name: member.display_name, imageUrl: member.image_url })}
                  >
                    <Avatar className="h-9 w-9">
                      {member.image_url && <AvatarImage src={member.image_url} alt={member.display_name} />}
                      <AvatarFallback className="text-xs bg-primary/10 text-primary font-medium">
                        {abbr}
                      </AvatarFallback>
                    </Avatar>

                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {member.display_name}
                        {isSelf && (
                          <span className="ml-2 text-xs text-muted-foreground font-normal">(you)</span>
                        )}
                      </p>
                    </div>

                    <Badge variant={roleMeta.variant} className="gap-1 shrink-0">
                      <RoleIcon className="h-3 w-3" />
                      {roleMeta.label}
                    </Badge>

                    {isAdmin && !isSelf && !isOwnerOrAdmin && rKey !== 'guest' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs shrink-0 gap-1"
                        disabled={roleMutation.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          roleMutation.mutate({ clerkUserId: member.clerk_user_id, role: rKey === 'viewer' ? 'org:member' : 'viewer' });
                        }}
                      >
                        <Eye className="h-3 w-3" /> {rKey === 'viewer' ? 'Make member' : 'Make viewer'}
                      </Button>
                    )}

                    {isAdmin && !isSelf && rKey !== 'owner' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                        onClick={(e) => { e.stopPropagation(); setConfirmRemoveId(member.id); }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Invite link dialog */}
      {inviteOpen && <InviteDialog onClose={() => setInviteOpen(false)} />}

      {/* Member stats dialog */}
      {statsTarget && (
        <MemberStatsDialog
          clerkUserId={statsTarget.clerkUserId}
          name={statsTarget.name}
          imageUrl={statsTarget.imageUrl}
          initials={initials(statsTarget.clerkUserId)}
          onClose={() => setStatsTarget(null)}
        />
      )}

      {/* Confirm remove dialog */}
      <Dialog open={!!confirmRemoveId} onOpenChange={(open) => !open && setConfirmRemoveId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove member?</DialogTitle>
            <DialogDescription>
              {confirmTarget
                ? `${confirmTarget.display_name} will be removed from this workspace and lose access immediately.`
                : 'This member will be removed from the workspace.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmRemoveId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => confirmRemoveId && removeMutation.mutate(confirmRemoveId)}
              disabled={removeMutation.isPending}
            >
              {removeMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Member Stats Dialog ───────────────────────────────────────────────────────

interface NinjaTaskProfile {
  level: number;
  xp: number;
  coins: number;
  username: string | null;
  longestStreak: number;
  avatar: unknown | null;
}

function MemberStatsDialog({
  clerkUserId,
  name,
  imageUrl,
  initials,
  onClose,
}: {
  clerkUserId: string;
  name: string;
  imageUrl: string | null;
  initials: string;
  onClose: () => void;
}) {
  const { apiRequest } = useApiClient();
  const { data: stats, isLoading } = useQuery<MemberStats>({
    queryKey: ['/api/workspaces/me/members', clerkUserId, 'stats'],
    queryFn: () => apiRequest<MemberStats>('GET', `/api/workspaces/me/members/${clerkUserId}/stats`),
    staleTime: 60_000,
  });

  const { data: ntProfile } = useQuery<NinjaTaskProfile | null>({
    queryKey: ['/api/integrations/ninja-task/profile', clerkUserId],
    queryFn: () => apiRequest<NinjaTaskProfile | null>('GET', `/api/integrations/ninja-task/profile?clerkId=${encodeURIComponent(clerkUserId)}`),
    staleTime: 5 * 60_000,
    // Graceful degradation — never throw for missing integration
    retry: false,
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <Avatar className="h-10 w-10">
              {imageUrl && <AvatarImage src={imageUrl} alt={name} />}
              <AvatarFallback className="text-sm bg-primary/10 text-primary font-medium">{initials}</AvatarFallback>
            </Avatar>
            <div>
              <DialogTitle className="text-base">{name}</DialogTitle>
              <DialogDescription>Activity overview</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-3 py-2">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        ) : stats ? (
          <div className="space-y-4 py-1">
            {/* Completion rate */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5" /> Completion rate
                </span>
                <span className="font-semibold">{stats.completion_rate}%</span>
              </div>
              <Progress value={stats.completion_rate} className="h-2" />
            </div>

            <Separator />

            {/* Task breakdown */}
            <div className="grid grid-cols-2 gap-3">
              <StatPill icon={<CheckCircle2 className="h-3.5 w-3.5 text-green-500" />} label="Done" value={stats.done} />
              <StatPill icon={<Clock className="h-3.5 w-3.5 text-blue-500" />} label="In Progress" value={stats.in_progress} />
              <StatPill icon={<AlertTriangle className="h-3.5 w-3.5 text-orange-500" />} label="Overdue" value={stats.overdue} highlight={stats.overdue > 0} />
              <StatPill icon={<span className="h-3.5 w-3.5 rounded-full bg-muted-foreground/40 inline-block" />} label="Todo" value={stats.todo} />
            </div>

            <Separator />

            {/* Sprints & comments */}
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <Zap className="h-3.5 w-3.5 text-yellow-500" /> Sprints participated
              </span>
              <span className="font-medium">{stats.sprint_count}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <MessageSquare className="h-3.5 w-3.5 text-purple-500" /> Comments written
              </span>
              <span className="font-medium">{stats.comment_count}</span>
            </div>
            <div className="flex items-center justify-between text-sm font-medium border-t pt-3">
              <span>Total tasks assigned</span>
              <span>{stats.total}</span>
            </div>

            {ntProfile && (
              <>
                <Separator />
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                    <Zap className="h-3 w-3 text-yellow-500" /> ninja-task
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    <StatPill icon={<span className="text-[10px] font-bold text-yellow-500">Lv</span>} label="Level" value={ntProfile.level} />
                    <StatPill icon={<Zap className="h-3.5 w-3.5 text-yellow-500" />} label="XP" value={ntProfile.xp} />
                    <StatPill icon={<span className="text-[10px] font-bold text-amber-500">🪙</span>} label="Coins" value={ntProfile.coins} />
                  </div>
                  {ntProfile.longestStreak > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Longest streak: <span className="font-semibold text-foreground">{ntProfile.longestStreak} days</span>
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground py-4 text-center">No stats available.</p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Invite Link Dialog ────────────────────────────────────────────────────────

function InviteDialog({ onClose }: { onClose: () => void }) {
  const { apiRequest } = useApiClient();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: active, isLoading } = useQuery<{ token: string; expires_at: string } | null>({
    queryKey: ['/api/workspaces/me/invites/active'],
    queryFn: () => apiRequest<{ token: string; expires_at: string } | null>('GET', '/api/workspaces/me/invites/active'),
    staleTime: 30_000,
  });

  const generateMut = useMutation({
    mutationFn: () => apiRequest<{ token: string; expires_at: string }>('POST', '/api/workspaces/me/invites'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/workspaces/me/invites/active'] }),
  });

  const revokeMut = useMutation({
    mutationFn: () => apiRequest('DELETE', '/api/workspaces/me/invites'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/workspaces/me/invites/active'] });
      toast({ title: 'Invite link revoked' });
    },
  });

  const inviteUrl = active
    ? `${window.location.origin}/invite/${active.token}`
    : null;

  const copyLink = () => {
    if (!inviteUrl) return;
    navigator.clipboard.writeText(inviteUrl).then(() => toast({ title: 'Link copied!' }));
  };

  const expiresLabel = active
    ? `Expires ${new Date(active.expires_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
    : null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-4 w-4" /> Workspace Invite Link
          </DialogTitle>
          <DialogDescription>
            Anyone with this link can join this workspace as a member. The link expires after 7 days and can only be used once.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {isLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : inviteUrl ? (
            <>
              <div className="flex gap-2">
                <Input readOnly value={inviteUrl} className="text-xs font-mono" />
                <Button size="icon" variant="outline" onClick={copyLink} title="Copy link">
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{expiresLabel}</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-2"
                  disabled={generateMut.isPending}
                  onClick={() => {
                    if (window.confirm('Regenerating will invalidate the current link — anyone you already shared it with will no longer be able to use it. Continue?')) {
                      generateMut.mutate();
                    }
                  }}
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Regenerate
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-2 text-destructive hover:text-destructive"
                  disabled={revokeMut.isPending}
                  onClick={() => revokeMut.mutate()}
                >
                  <X className="h-3.5 w-3.5" /> Revoke
                </Button>
              </div>
            </>
          ) : (
            <div className="text-center py-4 space-y-3">
              <p className="text-sm text-muted-foreground">No active invite link.</p>
              <Button
                size="sm"
                className="gap-2"
                disabled={generateMut.isPending}
                onClick={() => generateMut.mutate()}
              >
                {generateMut.isPending
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Link2 className="h-4 w-4" />
                }
                Generate Invite Link
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatPill({
  icon,
  label,
  value,
  highlight,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div className={cn(
      'flex items-center gap-2 rounded-lg px-3 py-2 text-sm',
      highlight ? 'bg-destructive/10' : 'bg-muted/50',
    )}>
      {icon}
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground leading-none mb-0.5">{label}</p>
        <p className={cn('font-semibold', highlight && value > 0 ? 'text-destructive' : '')}>{value}</p>
      </div>
    </div>
  );
}
