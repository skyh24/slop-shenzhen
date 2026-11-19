const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('./helpers/module.cjs');

const read = name => readFileSync(join(__dirname, '../js', name), 'utf8');
const { deckLaneProfile, getDeckSection, getRoadSection, laneOffsets } = loadModule(read('sz-road-section.js'));

const GROUND = { osmId: 'way/1', highway: 'primary', widthSource: 'estimate-from-class',
  heightSource: 'terrain', bridge: false, tunnel: false, layer: 0 };
const REVIEWED = { ...GROUND, crossSection: { laneWidthM: 3.5, laneCountSource: 'municipal-design-and-relative-imagery' } };
const CAR_HALF_WIDTH_M = 0.9;

const sectionFor = (width, lanes, direction, metadata = GROUND) => getRoadSection(
  { links: [[0, 1, 0, width, lanes, direction, []]], metadata: [metadata] }, 0);
const ascending = values => values.every((value, i) => !i || value > values[i - 1]);
const halved = section => section.travelWidthM / 2;
const fits = section => values => values.every(value => Math.abs(value) + CAR_HALF_WIDTH_M <= halved(section));

test('two-way reviewed four lanes expose two forward offsets in ascending right order', () => {
  const section = sectionFor(14, 4, 0, REVIEWED);
  const offsets = laneOffsets(section);
  assert.equal(section.reviewed, true);
  assert.equal(section.laneCount, 4);
  assert.deepEqual([...offsets], [1.75, 5.25]);
  assert.ok(ascending(offsets), 'offsets ascend from the divider towards the right curb');
  assert.ok(offsets.every(offset => offset > 0 && offset <= halved(section)));
  assert.ok(fits(section)(offsets));
  assert.deepEqual([...section.routeOffsetsM], [...offsets]);
});

test('two-way reviewed five lanes use the odd forward half without negative offsets', () => {
  const section = sectionFor(17.5, 5, 0, REVIEWED);
  const offsets = laneOffsets(section);
  assert.equal(section.forwardCentersM.length, 3);
  assert.equal(section.backwardCentersM.length, 2);
  assert.equal(offsets.length, 3);
  assert.deepEqual([...laneOffsets(section, -1)], [2.1875, 6.5625]);
  assert.ok(ascending(offsets));
  assert.ok(offsets.every(offset => offset > 0));
  assert.deepEqual([...offsets], [...section.forwardCentersM].map(center => -center).reverse());
  assert.ok(fits(section)(offsets));
  assert.ok(section.forwardCentersM.every(center => center < 0), 'forward centers stay in the negative half');
  assert.ok(section.backwardCentersM.every(center => center > 0), 'backward centers switch to the positive half');
});

test('one-way reviewed three lanes keep the whole carriageway in right offsets', () => {
  const section = sectionFor(10.5, 3, 1, REVIEWED);
  const offsets = laneOffsets(section);
  assert.equal(section.twoWay, false);
  assert.deepEqual([...offsets], [-3.5, 0, 3.5]);
  assert.ok(ascending(offsets));
  assert.equal(offsets.at(-1), halved(section) - section.forwardLaneWidthM / 2);
  assert.ok(fits(section)(offsets));
  assert.deepEqual([...section.routeOffsetsM], [...offsets]);
});

test('estimated sections drive on the same lane centers that are painted', () => {
  const section = sectionFor(13, 0, 0);
  assert.equal(section.estimated, true);
  assert.equal(section.laneSource, 'width-estimate');
  assert.deepEqual([...laneOffsets(section)], [1.625, 4.875]);
  assert.deepEqual([...section.routeOffsetsM], [1.625, 4.875]);
  const oneWay = sectionFor(6.5, 0, 1);
  assert.deepEqual([...laneOffsets(oneWay)], [-1.625, 1.625]);
});

test('ground and elevated carriageways share lane widths with barriers outside the source width', () => {
  for (const [width, lanes, direction] of [[6.5, 0, 1], [9.8, 3, 1], [16, 0, 0], [18, 5, 0], [13, 4, -1]]) {
    const graph = { links: [[0, 1, 0, width, lanes, direction, []]], metadata: [GROUND] };
    const profile = deckLaneProfile(graph.links[0]);
    const ground = getRoadSection(graph, 0);
    const deck = getDeckSection(graph, { ...profile, index: 0, width: profile.widthM });
    assert.equal(deck.travelWidthM, ground.travelWidthM);
    assert.deepEqual([...deck.dividerOffsetsM], [...ground.dividerOffsetsM]);
    for (const sign of direction === 0 ? [1, -1] : [direction]) {
      assert.deepEqual([...laneOffsets(deck, sign)], [...laneOffsets(ground, sign)]);
    }
    assert.ok(deck.pavementWidthM / 2 - deck.barrierWidthM >= width / 2 + 0.5 - 1e-8);
  }
});

test('two-way sections with explicit OSM lanes are eligible without a reviewed cross section', () => {
  const section = sectionFor(14, 4, 0);
  assert.equal(section.reviewed, false);
  assert.equal(section.estimated, false);
  assert.equal(section.laneSource, 'osm-lanes');
  const offsets = laneOffsets(section);
  assert.deepEqual([...offsets], [1.75, 5.25]);
  assert.deepEqual([...section.routeOffsetsM], [...offsets]);
});

test('every lane offset plus half a car stays inside the travel half width', () => {
  const cases = [
    [10.5, 3, 1, REVIEWED], [14, 4, 0, REVIEWED], [17.5, 5, 0, REVIEWED],
    [10.5, 4, 0], [20, 6, 0], [13, 0, 0], [9, 0, 1],
    [52, 16, 1], [10.5, 3, -1, REVIEWED]
  ];
  for (const [width, lanes, direction, metadata = GROUND] of cases) {
    const section = sectionFor(width, lanes, direction, metadata);
    const offsets = laneOffsets(section);
    if (!offsets) {
      assert.ok(section.estimated || section.laneSource === 'width-estimate');
      assert.deepEqual([...section.routeOffsetsM], [...section.defaultOffsetsM]);
      continue;
    }
    assert.ok(offsets.length > 0);
    assert.ok(ascending(offsets), `${width}m ${lanes} lanes direction ${direction}`);
    assert.ok(fits(section)(offsets), `${width}m ${lanes} lanes direction ${direction}`);
    assert.deepEqual([...section.routeOffsetsM], [...offsets]);
  }
});
