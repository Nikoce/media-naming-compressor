// Update the version and these user-facing notes together for each release.
export const RELEASE = {
  version: '0.9.1',
  title: '修正开场音乐后的首句字幕',
  date: '2026-10-15',
  features: [
    { title: '首句时间再次校准', description: '修正开场音乐后，首句字幕提前出现、提前消失的问题。遇到异常词时间时，再参考句级时间校准；无法校准时提示人工校对。' },
    { title: '新增 13 款常用字体', description: '微软雅黑、黑体、宋体、楷体、Arial、Impact 等，共 16 个字体选项，预览与导出保持一致。' },
    { title: '新功能及时提醒', description: '发现新版本时展示更新说明，空闲页面自动刷新；有视频或字幕任务时，等你保存后再更新。' },
  ],
};
