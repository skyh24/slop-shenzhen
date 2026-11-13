"""审计正式车行图、源快照和分层交汇，输出可复核的本地清单。"""

import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
from pathlib import Path
import pickle
import sys

from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/sz'))
from roadgraph import graph_components


def structure(road):
    if road['tunnel'] and road['bridge']:
        return 'contradictory'
    if road['tunnel']:
        return 'tunnel'
    if road['bridge'] or road['layer'] > 0:
        return 'bridge'
    return 'unresolved-below' if road['layer'] < 0 else 'ground'


def classify(a, b, shared):
    if 'contradictory' in (a['structure'], b['structure']):
        return 'unknown'
    if shared and (a['highway'].endswith('_link') or b['highway'].endswith('_link')):
        return 'ramp-node'
    if shared:
        if a['structure'] == b['structure'] == 'ground':
            return 'ground-junction'
        return 'structure-node' if a['layer'] == b['layer'] and a['structure'] == b['structure'] else 'level-transition-node'
    levels = [road['layer'] or {'bridge': 1, 'tunnel': -1}.get(road['structure'], 0) for road in (a, b)]
    if levels[0] == levels[1] or 'unresolved-below' in (a['structure'], b['structure']):
        return 'unknown'
    if all(levels):
        return 'multi-level-crossing'
    return 'bridge-crossing' if max(levels) > 0 else 'tunnel-crossing'


def audit(graph, source, runtime=None):
    node_ids = graph['nodeIds']
    coords = list(zip(graph['nodes'][::2], graph['nodes'][1::2]))
    incidence, refs = defaultdict(list), defaultdict(list)
    source_by_id = {road['id']: road for road in source['roads']} if source else {}
    represented = {row['osmId'] for row in graph['metadata']}
    for road in source_by_id.values():
        for ref in set(road['nodeRefs']):
            refs[f'node/{ref}'].append(road['id'])

    edges, lines = [], []
    for i, (link, meta) in enumerate(zip(graph['links'], graph['metadata'])):
        a, b, name, width, lanes, direction, inner = link
        tags = source_by_id.get(meta['osmId'], {}).get('tags', {})
        edge = dict(meta, index=i, nodes=[node_ids[a], node_ids[b]], direction=direction,
                    name=graph['names'][name], widthM=width, lanes=lanes, structure=structure(meta),
                    sourceTags={key: tags[key] for key in ('bridge', 'tunnel', 'layer', 'junction',
                                'access', 'vehicle', 'motor_vehicle', 'motorcar', 'oneway') if key in tags})
        if runtime is not None:
            edge['runtimeDirections'] = runtime['directions'].get(i, [])
        edges.append(edge)
        lines.append(LineString([coords[a], *zip(inner[::2], inner[1::2]), coords[b]]))
        incidence[a].append(i)
        incidence[b].append(i)

    crossings, connections, ends = [], [], []
    movement_counts = Counter()
    runtime_movements = runtime['movements'] if runtime else {}
    corridor_names = ('深南大道', '北环大道', '滨海大道', '南坪快速', '南光高速')
    corridors = {name: {'main': [], 'frontage': [], 'ramps': [], 'structurePending': [], 'endpointReview': []}
                 for name in corridor_names}
    for edge in edges:
        for name, corridor in corridors.items():
            if edge['name'] == name:
                corridor['main'].append(edge['index'])
            if edge['name'] == f'{name}辅路':
                corridor['frontage'].append(edge['index'])
            if edge['name'] == name and edge['structure'] != 'ground' and not edge.get('runtimeDirections'):
                corridor['structurePending'].append(edge['index'])
    for node, incident in incidence.items():
        if len(incident) == 1:
            edge = edges[incident[0]]
            node_id = node_ids[node]
            other_ways = sorted(set(refs.get(node_id, ())) - {edge['osmId']})
            if node_id.startswith('clip/'):
                reason = 'coverage-clip'
            elif other_ways:
                reason = 'source-neighbor-omitted-or-node-mismatch'
            else:
                reason = 'source-end-needs-verification'
            for name, corridor in corridors.items():
                if edge['index'] in corridor['main'] or edge['index'] in corridor['frontage']:
                    corridor['endpointReview'].append(node_id)
            ends.append({'node': node_id, 'edge': edge['index'], 'reason': reason,
                         'sourceNeighborWays': other_ways,
                         'omittedNeighborWays': [way for way in other_ways if way not in represented]})
            continue
        node_id = node_ids[node]
        movements = []
        for i in incident:
            incoming = 1 if edges[i]['nodes'][1] == node_id else -1
            if edges[i]['direction'] not in (0, incoming):
                continue
            for j in incident:
                if i == j:
                    continue
                outgoing = 1 if edges[j]['nodes'][0] == node_id else -1
                if edges[j]['direction'] not in (0, outgoing):
                    continue
                kind = classify(edges[i], edges[j], True)
                move = {'from': i, 'to': j, 'fromDirection': incoming, 'toDirection': outgoing, 'type': kind}
                if runtime:
                    move['runtime'] = (j, outgoing) in runtime_movements.get((i, incoming), ())
                movements.append(move)
                movement_counts[kind] += 1
        connections.append({'node': node_id, 'edges': incident, 'movements': movements})
        for name, corridor in corridors.items():
            if any(edges[i]['name'] == name for i in incident):
                corridor['ramps'].extend(i for i in incident if edges[i]['highway'].endswith('_link'))

    tree = STRtree(lines)
    for i, line in enumerate(lines):
        for j in map(int, tree.query(line, predicate='intersects')):
            if j <= i:
                continue
            a, b = edges[i], edges[j]
            shared = set(a['nodes']) & set(b['nodes'])
            intersection = line.intersection(lines[j])
            for part in getattr(intersection, 'geoms', (intersection,)):
                if part.is_empty:
                    continue
                if part.geom_type == 'Point' and any(
                    part.distance(endpoint) < 1e-6
                    for identity, endpoint in zip(a['nodes'], (Point(line.coords[0]), Point(line.coords[-1])))
                    if identity in shared
                ):
                    continue
                kind = 'unknown-overlap' if part.geom_type != 'Point' else classify(a, b, False)
                crossings.append({'edges': [i, j], 'type': kind, 'geometry': part.__geo_interface__})

    return {
        'counts': {'nodes': len(node_ids), 'edges': len(edges), 'ways': len(represented),
                   'snapshotRoadWays': len(source_by_id) if source else None,
                   'edgeStructures': dict(Counter(e['structure'] for e in edges)),
                   'crossings': dict(Counter(row['type'] for row in crossings)),
                   'movements': dict(movement_counts),
                   'runtimeEdges': sum(bool(e.get('runtimeDirections')) for e in edges) if runtime else None,
                   'runtimeDirectedEdges': sum(len(e.get('runtimeDirections', [])) for e in edges) if runtime else None,
                   'endpoints': dict(Counter(row['reason'] for row in ends)),
                   'sourceGraphConnectivity': graph_components(len(node_ids), graph['links'])},
        'corridors': {name: {key: sorted(set(values)) for key, values in corridor.items()}
                      for name, corridor in corridors.items()},
        'runtimeStructureConflicts': runtime.get('legacyGradeConflicts', []) if runtime else [],
        'compiledStructures': runtime.get('structures', []) if runtime else [],
        'edges': edges, 'sourceNodes': connections, 'unconnectedCrossings': crossings, 'endpoints': ends,
        'turnRestrictions': graph.get('turnRestrictions', []),
        'snapshotStructureWaysOutsideGraph': [
            {'way': road['id'], 'tags': road['tags']}
            for road in source_by_id.values()
            if road['id'] not in represented and any(road['tags'].get(key) not in (None, 'no', '0', 'false')
                                                     for key in ('bridge', 'tunnel', 'layer'))
        ]
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path, default=ROOT / 'js/sz-city.json.gz')
    parser.add_argument('--osm-cache', type=Path)
    parser.add_argument('--runtime', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    packed = args.package.read_bytes()
    payload = json.loads(gzip.decompress(packed))
    source = None
    if args.osm_cache:
        with args.osm_cache.open('rb') as stream:
            source = pickle.load(stream)
    runtime = None
    if args.runtime:
        runtime = json.loads(args.runtime.read_text())
        directions = defaultdict(list)
        for index, direction in runtime['edges']:
            directions[index].append(direction)
        runtime['directions'] = directions
        runtime['movements'] = {(i, direction): {tuple(item) for item in next_edges}
                                for i, direction, next_edges in runtime['movements']}
    result = audit(payload['roadGraph'], source, runtime)
    result['packageSha256'] = hashlib.sha256(packed).hexdigest()
    result['snapshotSha256'] = source['sourceSha256'] if source else None
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps(result['counts'], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
