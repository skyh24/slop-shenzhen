"""将已核实的父级用途仅补到指定的无用途子部件。"""

import json
from pathlib import Path

from shapely import union_all

MANIFEST = Path(__file__).resolve().parents[2] / 'data/source/chegongmiao-parent-review.json'


def _matches_geometry(record, spec):
    geometry = record['geom']
    return (abs(geometry.area - spec['areaM2']) <= 1
            and all(abs(actual - expected) <= 0.1 for actual, expected in zip(geometry.bounds, spec['boundsXZ'])))


def apply_reviewed_building_parent_uses(records, report):
    review = json.loads(MANIFEST.read_text())
    if review['version'] != 1:
        raise ValueError('Unsupported building parent review version')
    parent_spec = review['parent']
    ids = {parent_spec['osmId'], *[part['osmId'] for part in review['parts']]}
    selected = {identity: [] for identity in ids}
    for record in records:
        if record['id'] in selected:
            selected[record['id']].append(record)

    def withheld(reason):
        report['reviewedBuildingParentUses'] = {'status': 'withheld', 'parentId': parent_spec['osmId'], 'reason': reason}

    if any(len(items) != 1 for items in selected.values()):
        withheld('reviewed-source-identities-changed')
        return
    parent, = selected[parent_spec['osmId']]
    if parent['src'] != 'osm' or parent['isPart'] or parent['kind'] != parent_spec['sourceUse'] or not _matches_geometry(parent, parent_spec):
        withheld('reviewed-parent-changed')
        return
    parts = [selected[spec['osmId']][0] for spec in review['parts']]
    for part, spec in zip(parts, review['parts'], strict=True):
        if (part['src'] != 'osm' or not part['isPart'] or part['levels'] != spec['numFloorsOsm']
                or not _matches_geometry(part, spec) or part['geom'].intersection(parent['geom']).area < 0.99 * part['geom'].area):
            withheld('reviewed-part-changed')
            return
    coverage = union_all([part['geom'] for part in parts]).intersection(parent['geom']).area
    if coverage < 0.99 * parent['geom'].area:
        withheld('reviewed-parts-no-longer-cover-parent')
        return
    applied = []
    objects = []
    for part in parts:
        # 有明确用途标签的部件优先保留自身来源。
        outcome = {'id': part['id'], 'kind': part['kind'], 'status': 'preserved'}
        explicit_use = part.get('explicitUse') or ''
        normalized_use = explicit_use.strip().lower()
        type_tags = {'building': part.get('buildingType'), 'building:part': part.get('buildingPartType')}
        explicit_types = {value.strip().lower() for value in type_tags.values() if value} - {'', 'yes'}
        if explicit_types:
            outcome['typeTags'] = {key: value for key, value in type_tags.items() if value is not None}
        if normalized_use:
            outcome['explicitUse'] = explicit_use
        if normalized_use and normalized_use != parent['kind']:
            outcome.update(status='withheld', reason='explicit-building-use-conflicts-with-parent')
        elif explicit_types - {parent['kind']}:
            outcome.update(status='withheld', reason='explicit-building-or-part-type-conflicts-with-parent')
        elif normalized_use:
            outcome['reason'] = 'explicit-building-use-matches-parent'
        elif explicit_types or part['kind'] not in (None, '', 'yes'):
            outcome['reason'] = 'explicit-building-or-part-use'
        else:
            part['kind'] = parent['kind']
            part['kindSource'] = review['useSource']
            applied.append(part['id'])
            outcome.update(status='applied', kind=part['kind'], useSource=part['kindSource'])
        objects.append(outcome)
    report['reviewedBuildingParentUses'] = {'status': 'applied' if applied else 'no-inheritance',
                                            'parentId': parent_spec['osmId'], 'useSource': review['useSource'],
                                            'partIds': applied, 'objects': objects}
