import { useState } from 'react';
import { type WorkspaceMember } from '@/hooks/use-members';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Card } from '@/components/ui/card';
import { KanbanColumn } from './KanbanColumn';

export interface KanbanCard {
  id: string;
  title: string;
  description: string | null;
  tags: string[];
  position: number;
  status: 'todo' | 'in_progress' | 'done' | 'blocked';
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  due_date?: string | null;
  assignee_clerk_id?: string | null;
  checklist?: { id: string; text: string; done: boolean }[];
}

export interface KanbanColumnData {
  id: string;
  title: string;
  cards: KanbanCard[];
}

interface KanbanBoardProps {
  columns: KanbanColumnData[];
  onAddCard?: (columnId: string) => void;
  onCardClick?: (cardId: string) => void;
  onReorder?: (
    cardId: string,
    newStatus: string,
    newPosition: number,
    resequence?: Array<{ id: string; position: number }>,
  ) => void;
  onDeleteCard?: (cardId: string) => void;
  members?: WorkspaceMember[];
  /**
   * Unfiltered column contents. Pass this when `columns` is a filtered view so drag-and-drop
   * positions are computed relative to every card in the column, not just the visible ones.
   */
  allColumns?: KanbanColumnData[];
}

const BASE_POSITION = 1024;
const MIN_GAP = 4;
const MIN_BASE = 256;

export function KanbanBoard({
  columns,
  onAddCard,
  onCardClick,
  onReorder,
  onDeleteCard,
  members = [],
  allColumns,
}: KanbanBoardProps) {
  const [activeCard, setActiveCard] = useState<KanbanCard | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    const cardId = event.active.id as string;
    for (const col of columns) {
      const card = col.cards.find((c) => c.id === cardId);
      if (card) { setActiveCard(card); break; }
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveCard(null);
    if (!over || !onReorder || over.id === active.id) return;

    const cardId = active.id as string;
    const overId = over.id as string;

    // Positions must be computed against the FULL (unfiltered) column lists — when the page
    // filters cards (search/priority), computing neighbours from only the visible subset wrote
    // positions that collided with / jumped over hidden cards and corrupted the column order.
    const layout = allColumns ?? columns;

    const sourceColumn = layout.find((c) => c.cards.some((card) => card.id === cardId));
    const targetColumn =
      layout.find((c) => c.id === overId) ??
      layout.find((c) => c.cards.some((card) => card.id === overId));
    if (!targetColumn || !sourceColumn) return;

    const draggedCard = sourceColumn.cards.find((c) => c.id === cardId);
    if (!draggedCard) return;

    const byPosition = (a: KanbanCard, b: KanbanCard) => a.position - b.position;
    const sameColumn = sourceColumn.id === targetColumn.id;
    const fullTarget = [...targetColumn.cards].sort(byPosition);
    // Target list WITH the dragged card removed — insertion indexes refer to this list.
    const sortedTarget = fullTarget.filter((c) => c.id !== cardId);
    const originalIndex = sameColumn ? fullTarget.findIndex((c) => c.id === cardId) : -1;

    let insertIndex: number;
    if (overId === targetColumn.id) {
      // Dropped on the column body (empty area) — append at the end.
      insertIndex = sortedTarget.length;
    } else {
      const overIndex = sortedTarget.findIndex((c) => c.id === overId);
      if (overIndex === -1) return;
      let placeAfter: boolean;
      if (sameColumn) {
        // Moving DOWN within a column: the sortable preview shows the card taking the over
        // card's slot, i.e. landing AFTER it. Previously it was always inserted before the over
        // card, so downward drops landed one slot short and "move down by one" was a no-op.
        placeAfter = originalIndex < fullTarget.findIndex((c) => c.id === overId);
      } else {
        // Cross-column: place after the over card when the dragged card's centre is below the
        // over card's centre.
        const translated = active.rect.current.translated;
        placeAfter = translated
          ? translated.top + translated.height / 2 > over.rect.top + over.rect.height / 2
          : false;
      }
      insertIndex = placeAfter ? overIndex + 1 : overIndex;
    }

    // Same slot as before — nothing to do.
    if (sameColumn && insertIndex === originalIndex) return;

    const prevCard = insertIndex > 0 ? sortedTarget[insertIndex - 1] : undefined;
    const nextCard = insertIndex < sortedTarget.length ? sortedTarget[insertIndex] : undefined;

    let newPosition: number;
    let needsResequence = false;
    if (!prevCard && !nextCard) {
      newPosition = BASE_POSITION;
    } else if (!prevCard) {
      newPosition = Math.floor(nextCard!.position / 2);
      needsResequence = nextCard!.position < MIN_BASE;
    } else if (!nextCard) {
      newPosition = prevCard.position + BASE_POSITION;
    } else {
      const gap = nextCard.position - prevCard.position;
      newPosition = Math.floor((prevCard.position + nextCard.position) / 2);
      needsResequence = gap < MIN_GAP;
    }

    let resequenceData: Array<{ id: string; position: number }> | undefined;
    if (needsResequence) {
      const reordered = [...sortedTarget];
      reordered.splice(insertIndex, 0, draggedCard);
      resequenceData = reordered.map((card, i) => ({ id: card.id, position: (i + 1) * BASE_POSITION }));
      newPosition = (insertIndex + 1) * BASE_POSITION;
    }

    onReorder(cardId, targetColumn.id, newPosition, resequenceData);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <ScrollArea className="h-full w-full">
        <div className="flex gap-6 p-6 h-full">
          {columns.map((column) => (
            <KanbanColumn
              key={column.id}
              columnId={column.id}
              title={column.title}
              cards={column.cards}
              onAddCard={() => onAddCard?.(column.id)}
              onCardClick={onCardClick}
              onDeleteCard={onDeleteCard}
              members={members}
            />
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>

      <DragOverlay>
        {activeCard ? (
          <Card className="p-4 w-80 opacity-80">
            <h4 className="font-medium text-base mb-2">{activeCard.title}</h4>
            {activeCard.description && (
              <p className="text-sm text-muted-foreground line-clamp-2">{activeCard.description}</p>
            )}
          </Card>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
