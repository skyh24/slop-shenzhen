"""审计正式车行图、源快照和分层交汇，输出可复核的本地清单。"""

import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
from pathlib import Path
import pickle
import sys

from shapely import make_valid
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools/sz'))
from package_validation import ring_points
from roadgraph import graph_components


def junction_candidates(graph, edges, incidence, compiled, runtime_movements):
    """找出两端各有唯一地面延续的单向一级桥隧，供按同一模板复核。"""
    result = []
    for edge in edges:
        index = edge['index']
        kind = edge['structure']
        if (edge['runtimeDirections'] or index in compiled or edge['direction'] != 1
                or edge['highway'].endswith('_link') or kind not in ('bridge', 'tunnel')
                or (kind == 'bridge' and (not edge['bridge'] or edge['layer'] not in (0, 1)))
                or (kind == 'tunnel' and edge['layer'] != -1)):
            continue
        start, end = graph['links'][index][:2]
        if len(incidence[start]) != 2 or len(incidence[end]) != 2:
            continue
        entry = next(i for i in incidence[start] if i != index)
        exit_ = next(i for i in incidence[end] if i != index)
        if (graph['links'][entry][1] != start or graph['links'][exit_][0] != end
                or any(i in compiled or edges[i]['direction'] != 1 or edges[i]['structure'] != 'ground'
                       or not edges[i]['runtimeDirections'] for i in (entry, exit_))):
            continue
        upstream = graph['links'][entry][0]
        approaches = [(i, sign) for i in incidence[upstream] if i != entry for sign in edges[i]['runtimeDirections']
                      if (entry, 1) in runtime_movements.get((i, sign), ())]
        departures = runtime_movements.get((exit_, 1), ())
        if not approaches or not departures:
            continue
        chain = [edges[i] for i in (entry, index, exit_)]
        path = [chain[0]['nodes'][0], *[row['nodes'][1] for row in chain]]
        result.append({'edges': [entry, index, exit_],
                       'approachLengthsM': [edges[i]['lengthM'] for i in (entry, exit_)],
                       'route': {'id': f"junction-{kind}-{edge['osmId'].split('/')[-1]}-{start}",
                                 'kind': kind, 'junctionContinuation': True,
                                 'source': f"https://www.openstreetmap.org/{edge['osmId']}",
                                 'ways': [row['osmId'] for row in chain], 'pathNodes': path,
                                 'portalNodes': [path[0], path[-1]],
                                 'profileSource': 'project-design-estimate-from-source-junction'}})
    return result


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


def audit_elevated_roads(payload, edges, lines, incidence, runtime):
    """用与小地图相同的源属性找高架，再核对实体、路网和跨水证据。"""
    graph = payload['roadGraph']
    polygons = [make_valid(Polygon(ring_points(outer), [ring_points(ring) for ring in holes]))
                for outer, *holes in [*payload['water'], *payload.get('seaSurface', {}).get('polygons', [])]]
    water = STRtree(polygons)
    surfaces = dict(runtime['deckSurfaces'])
    portals = dict(runtime['groundPortals'])
    movements = runtime['movements']
    arrivals = {target for targets in movements.values() for target in targets}

    def ground_approaches(node, incoming):
        return [i for i in incidence[node] if edges[i]['structure'] == 'ground'
                and any(graph['links'][i][int((sign == 1) == incoming)] == node
                        for sign in edges[i]['runtimeDirections'])]

    rows = []
    for edge, line in zip(edges, lines):
        if edge['tunnel'] or not (edge['bridge'] or edge['layer'] > 0):
            continue
        index = edge['index']
        a, b = graph['links'][index][:2]
        surface = surfaces.get(index)
        directions = edge['runtimeDirections']
        expected_directions = [edge['direction']] if edge['direction'] else [1, -1]
        missing_directions = [sign for sign in expected_directions if sign not in directions]
        gaps = [{'direction': sign, 'entry': (index, sign) not in arrivals,
                 'exit': not movements.get((index, sign))}
                for sign in directions if (index, sign) not in arrivals or not movements.get((index, sign))]
        status = ('missing-deck' if surface is None else 'missing-vehicle-route' if missing_directions
                  else 'open-end' if gaps else 'connected')
        row = {key: edge[key] for key in ('index', 'osmId', 'name', 'nodes', 'highway', 'layer', 'bridge', 'lanes', 'lengthM')}
        row.update(status=status, surfaceId=surface, runtimeDirections=directions,
                   missingDirections=missing_directions, openEnds=gaps)

        if status == 'missing-deck' and edge['bridge']:
            overlap = unary_union([line.intersection(polygons[i]) for i in water.query(line, predicate='intersects')])
            row['waterOverlapM'] = round(overlap.length, 2)
            if overlap.length > 0:
                points = (Point(line.coords[0]), Point(line.coords[-1]))
                dry = [not bool(water.query(point, predicate='intersects').size) for point in points]
                incoming, outgoing = ((b, a) if edge['direction'] == -1 else (a, b))
                approaches = [ground_approaches(incoming, True), ground_approaches(outgoing, False)]
                if edge['direction'] == 0:
                    # 双向桥同时核对两端的进和出。
                    approaches += [ground_approaches(outgoing, True), ground_approaches(incoming, False)]
                row.update(portalHeightsM=[portals.get(a), portals.get(b)], dryPortals=dry,
                           groundApproaches=approaches)
                if (overlap.geom_type == 'LineString' and overlap.length >= 5
                        and all(dry) and all(h is not None for h in row['portalHeightsM'])
                        and all(approaches) and not edge['highway'].endswith('_link')):
                    row['candidate'] = 'cross-water-deck'
        rows.append(row)
    return rows


def audit(payload, source, runtime=None):
    graph = payload['roadGraph']
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

    compiled = runtime.get('structures', []) if runtime else []
    candidates = junction_candidates(graph, edges, incidence, {row['index'] for row in compiled},
                                     runtime_movements) if runtime else []
    elevated = audit_elevated_roads(payload, edges, lines, incidence, runtime) if runtime else []
    return {
        'counts': {'nodes': len(node_ids), 'edges': len(edges), 'ways': len(represented),
                   'snapshotRoadWays': len(source_by_id) if source else None,
                   'edgeStructures': dict(Counter(e['structure'] for e in edges)),
                   'crossings': dict(Counter(row['type'] for row in crossings)),
                   'movements': dict(movement_counts),
                   'runtimeEdges': sum(bool(e.get('runtimeDirections')) for e in edges) if runtime else None,
                   'runtimeDirectedEdges': sum(len(e.get('runtimeDirections', [])) for e in edges) if runtime else None,
                   'junctionContinuationCandidates': len(candidates) if runtime else None,
            'elevatedRoads': dict(Counter(row['status'] for row in elevated)) if runtime else None,
            'crossWaterDeckCandidates': sum(row.get('candidate') == 'cross-water-deck' for row in elevated)
            if runtime else None,
                   'endpoints': dict(Counter(row['reason'] for row in ends)),
                   'sourceGraphConnectivity': graph_components(len(node_ids), graph['links'])},
        'corridors': {name: {key: sorted(set(values)) for key, values in corridor.items()}
                      for name, corridor in corridors.items()},
        'runtimeStructureConflicts': runtime.get('legacyGradeConflicts', []) if runtime else [],
        'compiledStructures': compiled, 'junctionContinuationCandidates': candidates,
        'elevatedRoads': elevated,
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
    parser.add_argument('--runtime', type=Path, help='output of road-network-runtime.mjs for this package')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    packed = args.package.read_bytes()
    digest = hashlib.sha256(packed).hexdigest()
    payload = json.loads(gzip.decompress(packed))
    source = None
    if args.osm_cache:
        with args.osm_cache.open('rb') as stream:
            source = pickle.load(stream)
    runtime = None
    if args.runtime:
        runtime = json.loads(args.runtime.read_text())
        if runtime.get('packageSha256') != digest:
            parser.error('Runtime export must be generated from the same city package')
        directions = defaultdict(list)
        for index, direction in runtime['edges']:
            directions[index].append(direction)
        runtime['directions'] = directions
        runtime['movements'] = {(i, direction): {tuple(item) for item in next_edges}
                                for i, direction, next_edges in runtime['movements']}
    result = audit(payload, source, runtime)
    result['packageSha256'] = digest
    result['snapshotSha256'] = source['sourceSha256'] if source else None
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps(result['counts'], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
