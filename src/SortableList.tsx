import { type ReactNode, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";

function Item({
  id,
  label,
  children,
  move,
}: {
  id: string;
  label: string;
  children: ReactNode;
  move: (direction: number) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`preference sortable-card ${isDragging ? "is-dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        className="drag-handle"
        aria-label={label}
        {...attributes}
        {...listeners}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            move(e.key === "ArrowUp" ? -1 : 1);
          }
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <GripVertical size={20} />
      </button>
      {children}
    </div>
  );
}
export function SortableList({
  items,
  onChange,
  render,
  label,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  render: (id: string, index: number) => ReactNode;
  label: (id: string, index: number) => string;
}) {
  const [active, setActive] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const end = ({ active, over }: DragEndEvent) => {
    setActive(null);
    if (over && active.id !== over.id)
      onChange(
        arrayMove(
          items,
          items.indexOf(String(active.id)),
          items.indexOf(String(over.id)),
        ),
      );
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(e) => setActive(String(e.active.id))}
      onDragCancel={() => setActive(null)}
      onDragEnd={end}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <div className="preference-list">
          {items.map((id, i) => (
            <Item
              id={id}
              label={label(id, i)}
              key={id}
              move={(direction) => {
                const next = i + direction;
                if (next >= 0 && next < items.length)
                  onChange(arrayMove(items, i, next));
              }}
            >
              {render(id, i)}
            </Item>
          ))}
        </div>
      </SortableContext>
      <DragOverlay>
        {active ? (
          <div className="preference sortable-overlay">
            <GripVertical size={20} />
            {render(active, items.indexOf(active))}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
