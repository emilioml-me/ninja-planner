import { useLocation } from 'wouter';
import { formatDistanceToNow } from 'date-fns';
import { Bell, CheckCheck, MessageSquare, UserCheck, ClipboardList } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import {
  useNotifications,
  useUnreadCount,
  useMarkRead,
  useMarkAllRead,
  type Notification,
} from '@/hooks/use-notifications';

function NotifIcon({ type }: { type: string }) {
  if (type === 'task_assigned') return <UserCheck className="h-3.5 w-3.5 text-blue-500" />;
  if (type === 'comment_added') return <MessageSquare className="h-3.5 w-3.5 text-orange-500" />;
  if (type === 'review_submitted') return <ClipboardList className="h-3.5 w-3.5 text-purple-500" />;
  return <Bell className="h-3.5 w-3.5 text-muted-foreground" />;
}

function NotifItem({
  notif,
  onRead,
}: {
  notif: Notification;
  onRead: (id: string, link: string | null) => void;
}) {
  const unread = !notif.read_at;
  return (
    <button
      className={cn(
        'w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-muted/50 transition-colors',
        unread && 'bg-primary/5',
      )}
      onClick={() => onRead(notif.id, notif.link)}
    >
      <div className="mt-0.5 h-6 w-6 rounded-full bg-muted flex items-center justify-center shrink-0">
        <NotifIcon type={notif.type} />
      </div>
      <div className="flex-1 min-w-0 space-y-0.5">
        <p className={cn('text-sm leading-snug', unread ? 'font-medium' : 'text-muted-foreground')}>
          {notif.title}
        </p>
        {notif.body && (
          <p className="text-xs text-muted-foreground line-clamp-2">{notif.body}</p>
        )}
        <p className="text-[11px] text-muted-foreground">
          {formatDistanceToNow(new Date(notif.created_at), { addSuffix: true })}
        </p>
      </div>
      {unread && (
        <span className="mt-1.5 h-2 w-2 rounded-full bg-primary shrink-0" />
      )}
    </button>
  );
}

export function NotificationBell() {
  const [, navigate] = useLocation();
  const { data: notifications = [] } = useNotifications();
  const { data: countData } = useUnreadCount();
  const { mutate: markRead } = useMarkRead();
  const { mutate: markAllRead } = useMarkAllRead();

  const unread = countData?.count ?? 0;

  const handleRead = (id: string, link: string | null) => {
    markRead(id);
    if (link) navigate(link);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative h-8 w-8">
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-primary text-[10px] font-bold text-primary-foreground flex items-center justify-center">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 p-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <span className="text-sm font-semibold">Notifications</span>
          {unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs text-muted-foreground"
              onClick={() => markAllRead()}
            >
              <CheckCheck className="h-3.5 w-3.5" />
              Mark all read
            </Button>
          )}
        </div>

        {/* List */}
        <ScrollArea className="max-h-[360px]">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center px-4">
              <Bell className="h-8 w-8 text-muted-foreground/40 mb-2" />
              <p className="text-sm text-muted-foreground">No notifications yet</p>
            </div>
          ) : (
            <div className="divide-y">
              {notifications.map((n, i) => (
                <div key={n.id}>
                  <NotifItem notif={n} onRead={handleRead} />
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        {notifications.length > 0 && (
          <>
            <Separator />
            <p className="px-4 py-2 text-[11px] text-center text-muted-foreground">
              Showing last {notifications.length} notifications
            </p>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
