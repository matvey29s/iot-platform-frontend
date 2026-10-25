import { useEffect, useRef, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from 'reactflow';

/**
 * Edge with a delete (×) button that appears ONLY while the pointer is over
 * the connection (or the button itself), or while the edge is selected.
 * A short leave-delay lets the pointer travel from the line to the button
 * without the button vanishing in between.
 */
export default function DeletableEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data, selected } = props;
  const [hover, setHover] = useState(false);
  const leaveTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  const enter = () => {
    window.clearTimeout(leaveTimer.current);
    setHover(true);
  };
  const leave = () => {
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => setHover(false), 120);
  };

  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const visible = hover || selected;

  return (
    <>
      <g onMouseEnter={enter} onMouseLeave={leave}>
        <BaseEdge
          id={id}
          path={edgePath}
          markerEnd={markerEnd}
          interactionWidth={24}
          style={{ ...style, stroke: visible ? '#ff8a8a' : style?.stroke, strokeWidth: visible ? 2.5 : style?.strokeWidth }}
        />
      </g>
      {visible && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan"
            onMouseEnter={enter}
            onMouseLeave={leave}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all'
            }}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                data?.onDelete?.(id);
              }}
              title="Удалить связь"
              aria-label="Удалить связь"
              style={{
                width: 20,
                height: 20,
                borderRadius: 999,
                border: '1px solid #ff5c5c',
                background: '#171d2b',
                color: '#ff5c5c',
                fontSize: 13,
                lineHeight: '17px',
                cursor: 'pointer',
                padding: 0
              }}
            >
              ×
            </button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
