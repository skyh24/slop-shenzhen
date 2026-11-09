"""按 OSM 节点身份建立路网；不把空间上相交的跨层道路拼成路口。"""

from collections import Counter

from shapely.geometry import LineString, Point

from geo import project
from roads import CLASS_OF, _num, road_dimensions, road_direction

DRIVABLE = {hw for hw, cls in CLASS_OF.items() if cls not in ('service', 'pedestrian')}


def graph_components(count, links):
    """有向强连通审计，不删掉小分量，保留原始数据供排查。"""
    forward, reverse = [[] for _ in range(count)], [[] for _ in range(count)]
    for a, b, _, _, _, direction, _ in links:
        for src, dst in ([(a, b)] if direction == 1 else [(b, a)] if direction == -1 else [(a, b), (b, a)]):
            forward[src].append(dst)
            reverse[dst].append(src)
    seen, order = set(), []
    for start in range(count):
        if start in seen:
            continue
        seen.add(start)
        stack = [(start, iter(forward[start]))]
        while stack:
            node, children = stack[-1]
            child = next(children, None)
            if child is None:
                order.append(node)
                stack.pop()
            elif child not in seen:
                seen.add(child)
                stack.append((child, iter(forward[child])))
    labels, sizes = [-1] * count, []
    for start in reversed(order):
        if labels[start] != -1:
            continue
        component, size, stack = len(sizes), 0, [start]
        labels[start] = component
        while stack:
            node = stack.pop()
            size += 1
            for child in reverse[node]:
                if labels[child] == -1:
                    labels[child] = component
                    stack.append(child)
        sizes.append(size)
    largest = max(range(len(sizes)), key=sizes.__getitem__) if sizes else -1
    retained = sum(labels[l[0]] == largest and labels[l[1]] == largest for l in links)
    return {'components': len(sizes), 'largestNodes': max(sizes, default=0),
            'largestNodeFraction': round(max(sizes, default=0) / max(count, 1), 4),
            'largestLinks': retained, 'largestLinkFraction': round(retained / max(len(links), 1), 4)}


def build_roadgraph(osm, clip, report):
    selected, skipped = [], Counter()
    for road in osm['roads']:
        tags = road['tags']
        if tags.get('highway') not in DRIVABLE:
            skipped['nonDrivableClass'] += 1
            continue
        access = next((tags[k] for k in ('motorcar', 'motor_vehicle', 'vehicle', 'access') if k in tags), None)
        if access in ('no', 'private'):
            skipped['accessRestricted'] += 1
            continue
        if road_direction(tags) is None:
            skipped['variableDirection'] += 1
            continue
        if len(road.get('nodeRefs', [])) != len(road['geom'].coords):
            raise ValueError(f'Missing OSM node references: {road["id"]}')
        selected.append(road)
    uses = Counter(ref for r in selected for ref in r['nodeRefs'])
    nodes, node_ids, keys, names, name_ids, links, metadata = [], [], {}, [], {}, [], []

    def node(key, xy):
        if key not in keys:
            keys[key] = len(node_ids)
            node_ids.append(key)
            nodes.extend(round(v, 2) for v in xy)
        return keys[key]

    for road in selected:
        tags, refs = road['tags'], road['nodeRefs']
        coords = [project(*p) for p in road['geom'].coords]
        cuts = {0, len(refs) - 1} | {i for i, ref in enumerate(refs) if uses[ref] > 1}
        if refs[0] == refs[-1]:
            cuts.add(len(refs) // 2)
        cuts = sorted(cuts)
        # 小区道路可能先走进环路再返回中间节点；每个闭环都要有第二个真实节点。
        cuts = sorted(set(cuts) | {(a + b) // 2 for a, b in zip(cuts, cuts[1:])
                                   if refs[a] == refs[b] and b - a > 1})
        width, lanes, width_source = road_dimensions(tags)
        for start, end in zip(cuts, cuts[1:]):
            line = LineString(coords[start:end + 1])
            if line.length < 0.01:
                continue
            clipped = line.intersection(clip)
            for part_index, part in enumerate(getattr(clipped, 'geoms', [clipped])):
                if part.geom_type != 'LineString' or part.length < 0.01:
                    continue
                points = list(part.coords)
                if line.project(Point(points[0])) > line.project(Point(points[-1])):
                    points.reverse()

                def identity(xy, side):
                    for index in (start, end):
                        if Point(xy).distance(Point(coords[index])) < 1e-6:
                            return f'node/{refs[index]}'
                    return f'clip/{road["id"]}/{start}/{part_index}/{side}'

                a, b = node(identity(points[0], 'a'), points[0]), node(identity(points[-1], 'b'), points[-1])
                if a == b:
                    raise ValueError(f'Unsplit road loop: {road["id"]}')
                name = tags.get('name', '')
                if name not in name_ids:
                    name_ids[name] = len(names)
                    names.append(name)
                inner = [round(v, 2) for xy in points[1:-1] for v in xy]
                links.append([a, b, name_ids[name], width, lanes, road_direction(tags), inner])
                bridge = tags.get('bridge', 'no') not in ('no', 'false', '0')
                tunnel = tags.get('tunnel', 'no') not in ('no', 'false', '0')
                layer = _num(tags.get('layer')) or 0
                metadata.append({'osmId': road['id'], 'highway': tags['highway'],
                                 'layer': layer, 'bridge': bridge, 'tunnel': tunnel,
                                 'widthSource': width_source, 'heightSource': 'unresolved' if bridge or tunnel or layer else 'terrain',
                                 'lengthM': round(part.length, 2)})
    graph = {'nodes': nodes, 'nodeIds': node_ids, 'links': links, 'names': names, 'metadata': metadata}
    report['roadGraph'] = {'nodes': len(node_ids), 'links': len(links),
                          'lengthKm': round(sum(m['lengthM'] for m in metadata) / 1000, 2),
                          'bridgeLinks': sum(m['bridge'] for m in metadata),
                          'tunnelLinks': sum(m['tunnel'] for m in metadata),
                          'widthSources': dict(Counter(m['widthSource'] for m in metadata)),
                          'skipped': dict(skipped), 'connectivity': graph_components(len(node_ids), links),
                          'limitations': ['Conditional access is not yet imported',
                                          'Bridge and tunnel vertical profiles require source verification; layer is not height',
                                          'Unresolved vertical links are excluded from traffic and automatic driving']}
    return graph
