import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { Share2 } from 'lucide-react';

interface Node extends d3.SimulationNodeDatum {
  id: string;
  group: string;
  label?: string;
}

interface Link extends d3.SimulationLinkDatum<Node> {
  source: string;
  target: string;
}

interface KnowledgeGraphProps {
  manuscripts: any[];
  highlightId?: string;
}

const KnowledgeGraph: React.FC<KnowledgeGraphProps> = ({ manuscripts, highlightId }) => {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || !manuscripts) return;

    const width = 800;
    const height = 500;

    const nodes: Node[] = [];
    const links: Link[] = [];
    const nodeSet = new Set<string>();

    // Process all manuscripts to build a global graph
    manuscripts.forEach((m, idx) => {
      const mId = `M-${m.id || idx}`;
      const isHighlighted = m.id === highlightId;
      
      nodes.push({ 
        id: mId, 
        group: 'root', 
        label: m.title || m.summary?.slice(0, 20) + '...' || 'Manuscript' 
      });
      nodeSet.add(mId);
      
      const mEntities = m.entities || {};
      const entityIds: string[] = [];

      Object.entries(mEntities).forEach(([group, items]) => {
        if (Array.isArray(items)) {
          items.forEach((item) => {
            if (item && typeof item === 'string') {
              const eId = `E-${item}`;
              if (!nodeSet.has(eId)) {
                nodes.push({ id: eId, group, label: item });
                nodeSet.add(eId);
              }
              links.push({ source: mId, target: eId });
              entityIds.push(eId);
            }
          });
        }
      });

      // Create co-occurrence links between entities in the same manuscript
      // This makes the graph more "connected" and shows relationships
      for (let i = 0; i < entityIds.length; i++) {
        for (let j = i + 1; j < entityIds.length; j++) {
          links.push({ source: entityIds[i], target: entityIds[j] });
        }
      }
    });

    if (nodes.length === 0) return;

    const svg = d3.select(svgRef.current)
      .attr('viewBox', `0 0 ${width} ${height}`)
      .style('width', '100%')
      .style('height', '100%');

    svg.selectAll('*').remove();

    const g = svg.append('g');

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 8])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });

    svg.call(zoom);

    const simulation = d3.forceSimulation<Node>(nodes)
      .force('link', d3.forceLink<Node, Link>(links).id((d) => d.id).distance(100))
      .force('charge', d3.forceManyBody().strength(-300))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius(40))
      .force('x', d3.forceX(width / 2).strength(0.05))
      .force('y', d3.forceY(height / 2).strength(0.05))
      .alphaDecay(0.01) // Slower decay for more persistent movement
      .alphaTarget(0.005); // Keep a tiny bit of movement always

    const link = g.append('g')
      .attr('stroke', '#cbd5e1')
      .attr('stroke-opacity', 0.4)
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke-width', 1);

    const node = g.append('g')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .attr('class', 'node-group')
      .style('cursor', 'pointer')
      .call(drag(simulation) as any);

    node.append('circle')
      .attr('r', (d) => (d.group === 'root' ? 12 : 6))
      .attr('class', (d) => {
        const isRoot = d.group === 'root';
        const isHighlighted = d.id === `M-${highlightId}`;
        return (isRoot || isHighlighted) ? 'animate-pulse' : '';
      })
      .attr('fill', (d) => {
        if (d.id === `M-${highlightId}`) return '#f87171'; // Brighter red for highlighted
        switch (d.group) {
          case 'root': return '#ef4444';
          case 'kings': return '#3b82f6';
          case 'places': return '#10b981';
          case 'temples': return '#f59e0b';
          case 'events': return '#8b5cf6';
          case 'dynasties': return '#ec4899';
          default: return '#9ca3af';
        }
      })
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.5)
      .on('mouseover', function(event, d) {
        d3.select(this).transition().attr('r', d.group === 'root' ? 16 : 10).attr('stroke-width', 3);
        // Highlight connected links
        link.style('stroke', (l: any) => (l.source.id === d.id || l.target.id === d.id) ? '#64748b' : '#cbd5e1')
            .style('stroke-opacity', (l: any) => (l.source.id === d.id || l.target.id === d.id) ? 1 : 0.2)
            .style('stroke-width', (l: any) => (l.source.id === d.id || l.target.id === d.id) ? 2 : 1);
      })
      .on('mouseout', function(event, d) {
        d3.select(this).transition().attr('r', d.group === 'root' ? 12 : 6).attr('stroke-width', 1.5);
        link.style('stroke', '#cbd5e1').style('stroke-opacity', 0.4).style('stroke-width', 1);
      });

    node.append('text')
      .attr('dx', 12)
      .attr('dy', '.35em')
      .style('font-size', (d) => (d.group === 'root' || d.id === `M-${highlightId}`) ? '10px' : '8px')
      .style('font-weight', (d) => (d.group === 'root' || d.id === `M-${highlightId}`) ? 'bold' : '500')
      .style('fill', (d) => d.id === `M-${highlightId}` ? '#ef4444' : '#475569')
      .style('pointer-events', 'none')
      .text((d: any) => d.label || d.id);

    simulation.on('tick', () => {
      link
        .attr('x1', (d: any) => d.source.x)
        .attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x)
        .attr('y2', (d: any) => d.target.y);

      node
        .attr('transform', (d: any) => `translate(${d.x},${d.y})`);
    });

    function drag(simulation: d3.Simulation<Node, undefined>) {
      function dragstarted(event: any) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      }

      function dragged(event: any) {
        event.subject.fx = event.x;
        event.subject.fy = event.y;
      }

      function dragended(event: any) {
        if (!event.active) simulation.alphaTarget(0);
        event.subject.fx = null;
        event.subject.fy = null;
      }

      return d3.drag<SVGGElement, Node>()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended);
    }

    const handleReheat = () => {
      simulation.alpha(0.5).restart();
    };
    window.addEventListener('reheat-simulation', handleReheat);

    return () => {
      simulation.stop();
      window.removeEventListener('reheat-simulation', handleReheat);
    };
  }, [manuscripts, highlightId]);

  return (
    <div className="bg-white rounded-3xl shadow-sm border border-slate-200 p-6 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
          <Share2 size={20} className="text-emerald-600" />
          Interactive Knowledge Graph
        </h3>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => {
              // Re-heat simulation
              // We need access to simulation. We can store it in a ref.
              // For now, we can just trigger a state change or use the ref if we add it.
              // Actually, the easiest way is to add a 'reheat' function to the component.
              window.dispatchEvent(new CustomEvent('reheat-simulation'));
            }}
            className="p-2 hover:bg-slate-100 rounded-lg text-slate-500 transition-colors"
            title="Re-heat Simulation"
          >
            <Share2 size={16} className="animate-spin-slow" />
          </button>
          <button 
            onClick={() => {
              if (svgRef.current) {
                const svg = d3.select(svgRef.current);
                svg.transition().duration(750).call(
                  d3.zoom<SVGSVGElement, unknown>().transform as any, 
                  d3.zoomIdentity
                );
              }
            }}
            className="p-2 hover:bg-slate-100 rounded-lg text-slate-500 transition-colors"
            title="Reset Zoom"
          >
            <Share2 size={16} className="rotate-180" />
          </button>
          <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider bg-slate-50 px-2 py-1 rounded">Scroll to Zoom • Drag to Move</span>
        </div>
      </div>
      <div className="flex-1 min-h-0 bg-slate-50/50 rounded-2xl border border-slate-100 overflow-hidden relative group">
        <svg ref={svgRef} className="w-full h-full"></svg>
        <div className="absolute bottom-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="bg-white/80 backdrop-blur-sm border border-slate-200 rounded-xl p-2 shadow-lg flex flex-col gap-1">
            <div className="text-[9px] font-bold text-slate-400 uppercase px-2 mb-1">Physics</div>
            <div className="flex gap-1">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
              <div className="text-[10px] text-slate-600 font-medium">Active Simulation</div>
            </div>
          </div>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        <LegendItem color="bg-red-500" label="Manuscript" />
        <LegendItem color="bg-blue-500" label="Kings" />
        <LegendItem color="bg-emerald-500" label="Places" />
        <LegendItem color="bg-amber-500" label="Temples" />
        <LegendItem color="bg-violet-500" label="Events" />
        <LegendItem color="bg-pink-500" label="Dynasties" />
      </div>
    </div>
  );
};

const LegendItem = ({ color, label }: { color: string, label: string }) => (
  <span className="flex items-center gap-1.5 text-[11px] font-medium text-slate-600 bg-white px-2.5 py-1 rounded-full border border-slate-100 shadow-sm">
    <div className={`w-2 h-2 rounded-full ${color}`}></div>
    {label}
  </span>
);

export default KnowledgeGraph;
