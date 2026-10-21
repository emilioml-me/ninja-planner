import { useState, useEffect, useMemo, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { HelpCircle, ExternalLink, CheckCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError, useApiClient } from '@/lib/api';

interface TicketResult {
  ticketNumber: string;
  portalUrl: string;
}

const SUBJECT_MAX = 200;

/** Only http(s) portal links are rendered (never javascript:/data: from an upstream payload). */
function safePortalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

interface Props {
  trigger?: React.ReactNode;
}

export function ContactSupportDialog({ trigger }: Props) {
  const { apiRequest } = useApiClient();
  const [open, setOpen]             = useState(false);
  const [subject, setSubject]       = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority]     = useState<string>('medium');
  const [result, setResult]         = useState<TicketResult | null>(null);

  // Bumped whenever the dialog closes, so a submit that resolves after the user closed (and maybe
  // reopened) the dialog doesn't flash the old ticket's success screen.
  const session = useRef(0);
  const mutation = useMutation<TicketResult, Error, number>({
    mutationFn: () =>
      apiRequest('POST', '/api/support/ticket', { subject: subject.trim(), description, priority }),
    onSuccess: (data, startedIn) => {
      if (startedIn === session.current) setResult(data);
    },
  });

  // Per-field messages from a zod flatten() 400 ({ error: { formErrors, fieldErrors } }).
  const fieldErrors = useMemo(() => {
    const err = mutation.error;
    if (!(err instanceof ApiError) || err.status !== 400) return {} as Record<string, string>;
    const body = err.body as { error?: { fieldErrors?: Record<string, unknown> } } | undefined;
    const out: Record<string, string> = {};
    for (const [field, msgs] of Object.entries(body?.error?.fieldErrors ?? {})) {
      const list = Array.isArray(msgs) ? msgs.filter((m): m is string => typeof m === 'string' && !!m) : [];
      if (list.length > 0) out[field] = list.join(', ');
    }
    return out;
  }, [mutation.error]);
  const hasFieldErrors = Object.keys(fieldErrors).length > 0;

  const resetTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(resetTimer.current), []);

  function handleClose(isOpen: boolean) {
    setOpen(isOpen);
    if (!isOpen) {
      session.current += 1;
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => {
        setSubject('');
        setDescription('');
        setPriority('medium');
        setResult(null);
        mutation.reset();
      }, 200);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="ghost" size="sm" className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground">
            <HelpCircle className="h-4 w-4" />
            Contact Support
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HelpCircle className="h-4 w-4" />
            Contact Support
          </DialogTitle>
        </DialogHeader>

        {result ? (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <CheckCircle className="h-12 w-12 text-green-500" />
            <div>
              <p className="font-semibold text-lg">{result.ticketNumber}</p>
              <p className="text-sm text-muted-foreground mt-1">
                Your ticket has been submitted. We'll reply to your email shortly.
              </p>
            </div>
            {safePortalUrl(result.portalUrl) && (
              <a
                href={safePortalUrl(result.portalUrl)!}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
              >
                Track your ticket status
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
            <Button variant="outline" size="sm" onClick={() => handleClose(false)}>
              Close
            </Button>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (mutation.isPending) return;
              mutation.mutate(session.current);
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="sup-subject">Subject</Label>
              <Input
                id="sup-subject"
                placeholder="Brief description of your issue"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={SUBJECT_MAX}
                aria-invalid={!!fieldErrors.subject}
                required
              />
              {fieldErrors.subject && <p className="text-xs text-destructive">{fieldErrors.subject}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sup-description">Description</Label>
              <Textarea
                id="sup-description"
                placeholder="Describe the issue in detail..."
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                aria-invalid={!!fieldErrors.description}
                required
              />
              {fieldErrors.description && <p className="text-xs text-destructive">{fieldErrors.description}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sup-priority">Priority</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger id="sup-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
              {fieldErrors.priority && <p className="text-xs text-destructive">{fieldErrors.priority}</p>}
            </div>

            {mutation.isError && (
              <p className="text-sm text-destructive">
                {hasFieldErrors
                  ? 'Please fix the highlighted fields.'
                  : mutation.error?.message || 'Failed to submit ticket. Please try again.'}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => handleClose(false)}
                disabled={mutation.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={mutation.isPending || !subject.trim() || !description.trim()}
              >
                {mutation.isPending ? 'Submitting…' : 'Submit Ticket'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
