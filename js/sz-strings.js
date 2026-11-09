// 玩家可见文字集中在这里，代码里只引用键名
export const STR = {
  title: '深圳 · Slop Shenzhen',
  subtitle: 'MVP 预览 · 南山 + 福田 · APEC 2026 深圳',
  loading: '正在载入深圳……',
  loadingData: '读取地理数据',
  loadingBuild: '生成城市',
  loadingFailed: '载入失败',
  webgpuMissing: '当前浏览器不支持 WebGPU，请使用新版 Chrome 或 Edge。',
  landmarks: '地标',
  timeOfDay: '时间',
  day: '白天',
  dusk: '黄昏',
  night: '夜晚',
  follow: '跟随飞行器',
  freeCamera: '自由视角',
  routes: '无人机航线',
  apec: 'APEC 主题',
  stats: (b, c, d) => `建筑 ${b.toLocaleString()} 栋 · 车辆 ${c} 辆 · 无人机 ${d} 架`,
  help: '拖动平移 · 右键旋转 · 滚轮缩放 · 点地标跳转',
  apecBanner: 'APEC CHINA 2026 · 深圳 · 11月18—19日'
};
