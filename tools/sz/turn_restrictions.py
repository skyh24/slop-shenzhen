"""从锁定的 OSM 快照提取一期行车转向限制。"""

from collections import Counter, defaultdict

import osmium


MOTOR_MODES = ('taxi', 'motorcar', 'motor_vehicle', 'vehicle')
RELATION_TYPES = {'restriction', *(f'restriction:{mode}' for mode in MOTOR_MODES)}


def _rule_value(tags):
    for mode in MOTOR_MODES:
        value = tags.get(f'restriction:{mode}')
        if value:
            return value
    exempt = {mode.strip() for mode in tags.get('except', '').split(';')}
    return None if exempt.intersection(MOTOR_MODES) else tags.get('restriction')


def collect_turn_restrictions(relations, graph, report):
    """保留来源身份。多段 via-way 暂按进入端做保守限制。"""
    incoming, outgoing = defaultdict(set), defaultdict(set)
    for (a, b, _, _, _, direction, _), meta in zip(graph['links'], graph['metadata']):
        way = meta['osmId']
        for src, dst in ([(a, b)] if direction == 1 else [(b, a)] if direction == -1 else [(a, b), (b, a)]):
            outgoing[way].add(graph['nodeIds'][src])
            incoming[way].add(graph['nodeIds'][dst])

    rules, counts, incomplete = [], Counter(), []
    for osm_id, tags, members in relations:
        if tags.get('type') not in RELATION_TYPES:
            continue
        from_ways = [f'way/{ref}' for role, kind, ref in members if role == 'from' and kind == 'w']
        to_ways = [f'way/{ref}' for role, kind, ref in members if role == 'to' and kind == 'w']
        via_ways = [f'way/{ref}' for role, kind, ref in members if role == 'via' and kind == 'w']
        via_nodes = [f'node/{ref}' for role, kind, ref in members if role == 'via' and kind == 'n']
        if not any(way in incoming for way in from_ways + to_ways):
            continue
        restriction = _rule_value(tags)
        if not restriction or not restriction.startswith(('no_', 'only_')):
            counts['notApplicableToCar'] += 1
            continue
        if not from_ways or not to_ways or (len(via_nodes) != 1 and not via_ways) or (via_nodes and via_ways):
            counts['invalidMembers'] += 1
            incomplete.append(osm_id)
            continue
        rules_before = len(rules)
        for from_way in from_ways:
            entry_nodes = incoming.get(from_way, set()).intersection(outgoing.get(via_ways[0], ()) if via_ways else via_nodes)
            for node in sorted(entry_nodes):
                rules.append({'osmId': osm_id, 'restriction': restriction, 'fromWayId': from_way,
                              'toWayIds': to_ways, 'viaNodeId': node, 'viaWayIds': via_ways})
        if len(rules) > rules_before:
            counts['viaWayConservative' if via_ways else 'viaNode'] += 1
        else:
            counts['withoutGraphApproach'] += 1

    rules.sort(key=lambda rule: (rule['osmId'], rule['fromWayId'], rule['viaNodeId']))
    report['turnRestrictions'] = {'source': 'osm-guangdong', 'rules': len(rules), 'relations': dict(counts),
                                  'incompleteOsmIds': sorted(incomplete),
                                  'limitations': ['Via-way relations use conservative entry filtering',
                                                  'Conditional access is not modeled']}
    return {'version': 1, 'source': 'osm-guangdong', 'rules': rules}


def build_turn_restrictions(pbf, graph, report):
    objects = (osmium.FileProcessor(str(pbf), osmium.osm.RELATION)
               .with_filter(osmium.filter.KeyFilter('type')))
    relations = ((f'relation/{obj.id}', dict(obj.tags), [(m.role, m.type, m.ref) for m in obj.members])
                 for obj in objects if obj.tags.get('type') in RELATION_TYPES)
    return collect_turn_restrictions(relations, graph, report)
