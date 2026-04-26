import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { format } from 'date-fns';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Plus, MoreVertical, Calendar, AlertCircle, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { KanbanCard } from './KanbanBoard';

interface KanbanColumnProps {
  columnId: string;
  title: string;
  cards: KanbanCard[];
  onAddCard?: () => void;
  onCardClick?: (cardId: string) => void;
  onDeleteCard?: (cardId: string) => void;
}

function SortableCard({
  card,
  onCardClick,
  onDeleteCard,
}: {
  card: KanbanCard;
  onCardClick?: (id: string) => void;
  onDeleteCard?: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const priorityBorder: Record<string, string> = {
    urgent: 'border-l-red-600',
    high: 'border-l-orange-500',
    medium: 'border-l-yellow-500',
    low: 'border-l-green-500',
  };

  const borderClass = card.priority ? priorityBorder[card.priority] : '';

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <Card
        className={cn('p-3 border-l-4 group hover:shadow-md transition-shadow', borderClass)}
      >
        <div className="flex items-start justify-between gap-2 mb-2">
          <div {...listeners} className="flex-1 cursor-move" onClick={() => onCardClick?.(card.id)}>
            <h4 className="font-medium text-sm line-clamp-2">{card.title}</h4>
          </div>
          <div className="flex items-center gap-1">
            {(card.priority === 'urgent' || card.priority === 'high') && (
              <AlertCircle className="h-4 w-4 text-orange-500 flex-shrink-0" />
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreVertical className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteCard?.(card.id);
                  }}
                  className="text-destructive"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div {...listeners} className="cursor-move">
          {card.description && (
            <p className="text-xs text-muted-foreground line-clamp-2 mb-3">{card.description}</p>
          )}

          <div className="flex items-center gap-2 flex-wrap mb-2">
            {card.due_date && (
              <Badge variant="outline" className="text-xs gap-1">
                <Calendar className="h-3 w-3" />
                {format(new Date(card.due_date), 'MMM d')}
              </Badge>
            )}
            {card.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="text-xs">
                #{tag}
              </Badge>
            ))}
          </div>

          {card.assignee_clerk_id && (
            <div className="flex items-center gap-2 mt-2">
              <Avatar className="h-6 w-6">
                <AvatarFallback className="text-xs">
                  {card.assignee_clerk_id.substring(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

export function KanbanColumn({
  columnId,
  title,
  cards,
  onAddCard,
  onCardClick,
  onDeleteCard,
}: KanbanColumnProps) {
  const { setNodeRef } = useDroppable({ id: columnId });
  const sortedCards = [...cards].sort((a, b) => a.position - b.position);

  return (
    <div className="flex flex-col min-w-80 max-w-80 h-full">
      <div className="flex items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-sm">{title}</h3>
          <Badge variant="secondary" className="text-xs">
            {cards.length}
          </Badge>
        </div>
      </div>

      <div ref={setNodeRef} className="flex-1 overflow-y-auto space-y-3 min-h-20">
        <SortableContext items={sortedCards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {sortedCards.map((card) => (
            <SortableCard
              key={card.id}
              card={card}
              onCardClick={onCardClick}
              onDeleteCard={onDeleteCard}
            />
          ))}
          {sortedCards.length === 0 && (
            <div className="rounded-lg border border-dashed border-muted-foreground/25 p-4 text-center text-sm text-muted-foreground">
              No tasks
            </div>
          )}
        </SortableContext>
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={onAddCard}
        className="mt-3 gap-2 justify-start"
      >
        <Plus className="h-4 w-4" />
        Add Task
      </Button>
    </div>
  );
}
