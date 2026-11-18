// 直接量最终断面的中心与左右缘，不用源边端点高差代替局部纵坡。
const EPSILON_M = 1e-8;
const TRACES = ['center', 'left', 'right'];

function pointOnTrace(frame, trace) {
  return trace === 'center' ? frame : frame[trace];
}

export function roadProfileHeight(frame, trace = 'center') {
  const centerY = frame.y ?? frame.floorY ?? NaN;
  if (trace !== 'center') return frame[trace]?.y ?? centerY;
  return ((frame.left?.y ?? centerY) + (frame.right?.y ?? centerY)) / 2;
}

export function createRoadProfile() {
  return { maxGrade: 0, sections: {}, seams: [], issues: [] };
}

export function measureRoadProfile(profile, frames, sectionAt) {
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i];
    const sectionId = sectionAt(i - 1, a, b);
    const section = profile.sections[sectionId] ??= {
      maxGrade: 0, lengthM: 0, intervals: 0, worst: null,
      traces: { center: { maxGrade: 0 }, left: { maxGrade: 0 }, right: { maxGrade: 0 } }
    };
    section.lengthM += Math.hypot(b.x - a.x, b.z - a.z);
    section.intervals++;
    for (const trace of TRACES) {
      const u = pointOnTrace(a, trace), v = pointOnTrace(b, trace);
      const changeM = roadProfileHeight(b, trace) - roadProfileHeight(a, trace);
      const runM = Math.hypot(v?.x - u?.x, v?.z - u?.z);
      if (!Number.isFinite(changeM) || !Number.isFinite(runM)) {
        profile.issues.push({ section: sectionId, trace, fromM: a.d, toM: b.d, kind: 'unknown-interval' });
        continue;
      }
      const absenceOfRun = runM <= EPSILON_M;
      const grade = absenceOfRun ? (Math.abs(changeM) <= EPSILON_M ? 0 : Infinity) : Math.abs(changeM) / runM;
      if (!Number.isFinite(grade)) {
        profile.issues.push({ section: sectionId, trace, fromM: a.d, toM: b.d, kind: 'vertical-interval' });
      }
      if (grade > section.traces[trace].maxGrade || !section.traces[trace].worst) {
        section.traces[trace] = { maxGrade: grade, worst: { fromM: a.d, toM: b.d, changeM, runM } };
      }
      if (grade > section.maxGrade) {
        section.maxGrade = grade;
        section.worst = { trace, fromM: a.d, toM: b.d, changeM, runM, absenceOfRun };
      }
    }
    profile.maxGrade = Math.max(profile.maxGrade, section.maxGrade);
  }
  return profile;
}

// 零里程接缝记录高差，不用除以虚拟长度算坡，也不改变相邻层级的连接资格。
export function recordRoadProfileSeam(profile, { side, kind, node, peer, atM, fromY, toY, separated = false },
  toleranceM) {
  const valid = Number.isFinite(fromY) && Number.isFinite(toY);
  const deltaM = valid ? toY - fromY : null;
  const status = !valid ? 'unknown' : Math.abs(deltaM) <= toleranceM ? 'aligned'
    : separated ? 'layer-separated' : 'gap';
  profile.seams.push({ side, kind, node, peer, atM, fromY: fromY ?? null, toY: toY ?? null, deltaM, status });
}

// 由中心里程设计坡度时，给转弯或收边缩短的左右缘留出实际坡度余量。
export function centerGradeBudget(frames, targetGrade) {
  let budget = targetGrade;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i];
    const distanceM = b.d - a.d;
    if (distanceM <= EPSILON_M) continue;
    for (const side of ['left', 'right']) {
      const runM = Math.hypot(b[side].x - a[side].x, b[side].z - a[side].z);
      budget = Math.min(budget, targetGrade * runM / distanceM);
    }
  }
  return budget;
}
