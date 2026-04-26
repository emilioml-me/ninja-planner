import { useState } from 'react';
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
    let targetColumnId = over.id as string;

    for (const col of columns) {
      if (col.cards.some((c) => c.id === over.id)) {
        targetColumnId = col.id;
        break;
      }
    }

    const targetColumn = columns.find((c) => c.id === targetColumnId);
    const sourceColumn = columns.find((c) => c.cards.some((card) => card.id === cardId));
    if (!targetColumn || !sourceColumn) return;

    const draggedCard = sourceColumn.cards.find((c) => c.id === cardId);
    if (!draggedCard) return;

    const sortedTarget = [...targetColumn.cards]
      .filter((c) => c.id !== cardId)
      .sort((a, b) => a.position - b.position);

    let targetIndex: number;
    let newPosition: number;

    if (over.id === targetColumnId) {
      targetIndex = sortedTarget.length;
      const maxPos = sortedTarget.length > 0 ? Math.max(...sortedTarget.map((c) => c.position)) : 0;
      newPosition = maxPos + BASE_POSITION;
    } else {
      const overCard = targetColumn.cards.find((c) => c.id === over.id);
      if (!overCard || overCard.id === cardId) return;
      targetIndex = sortedTarget.indexOf(overCard);
      if (targetIndex === -1) return;

      if (targetIndex === 0) {
        newPosition = overCard.position >= MIN_BASE ? Math.floor(overCard.position / 2) : 0;
      } else {
        const prevCard = sortedTarget[targetIndex - 1];
        const gap = overCard.position - prevCard.position;
        newPosition = gap >= MIN_GAP ? Math.floor((prevCard.position + overCard.position) / 2) : 0;
      }
    }

    const needsResequence =
      newPosition < MIN_BASE ||
      (targetIndex > 0 &&
        targetIndex < sortedTarget.length &&
        sortedTarget[targetIndex].position - sortedTarget[targetIndex - 1].position < MIN_GAP);

    let resequenceData: Array<{ id: string; position: number }> | undefined;

    if (needsResequence) {
      const reordered = [...sortedTarget];
      reordered.splice(targetIndex, 0, draggedCard);
      resequenceData = reordered.map((card, i) => ({ id: card.id, position: (i + 1) * BASE_POSITION }));
      newPosition = (targetIndex + 1) * BASE_POSITION;
    }

    if (targetColumnId !== sourceColumn.id || newPosition !== draggedCard.position) {
      onReorder(cardId, targetColumnId, newPosition, resequenceData);
    }
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
