import { useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMembers } from '@/hooks/use-members';
import { useApiClient } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, Trash2, Users, Crown, Shield, User } from 'lucide-react';

const ROLE_META: Record<string, { label: string; icon: React.ElementType; variant: 'default' | 'secondary' | 'outline' }> = {
  owner:  { label: 'Owner',  icon: Crown,  variant: 'default'   },
  admin:  { label: 'Admin',  icon: Shield, variant: 'secondary' },
  member: { label: 'Member', icon: User,   variant: 'outline'   },
};

export default function Members() {
  const { userId, orgRole } = useAuth();
  const { members, initials, isLoading } = useMembers();
  const { apiRequest } = useApiClient();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

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

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Users className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Team Members</h1>
          <p className="text-sm text-muted-foreground">
            {members.length} member{members.length !== 1 ? 's' : ''} in this workspace
          </p>
        </div>
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
                const roleMeta = ROLE_META[member.role] ?? ROLE_META.member;
                const RoleIcon = roleMeta.icon;
                const isSelf = member.clerk_user_id === userId;
                const abbr = initials(member.clerk_user_id);

                return (
                  <li
                    key={member.id}
                    className="flex items-center gap-4 px-6 py-4 hover:bg-muted/40 transition-colors"
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

                    {isAdmin && !isSelf && member.role !== 'owner' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                        onClick={() => setConfirmRemoveId(member.id)}
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
