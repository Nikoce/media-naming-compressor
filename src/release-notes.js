// Update the version and these user-facing notes together for each release.
export const RELEASE = {
  version: '0.9.3',
  title: '按口播语言识别，改善短词与数字字幕',
  date: '2026-10-15',
  features: [
    { title: '英文口播使用 Tiny.en', description: '快速模式按语言选择模型：英语使用同级别的英文专用 Tiny.en，其他语言使用多语言 Tiny；Base 可按需选择。模型说明同步显示速度、能力和局限。' },
    { title: '短词与完整数字', description: '减少正常短词和相邻零时长词触发的重复识别，修正短词压缩到句尾的时间；字幕分段与画面换行保留数字、金额、小数和百分比的完整性。' },
    { title: '口播字幕与局部校准', description: '过滤音乐、掌声、笑声等声音标注，结合语音和停顿边界检查字幕时间。仅对剩余异常片段补充识别，每个视频最多 3 段、每段不超过 20 秒；不确定的位置提示校对。' },
    { title: '新增 13 款常用字体', description: '微软雅黑、黑体、宋体、楷体、Arial、Impact 等，共 16 个字体选项，预览与导出保持一致。' },
    { title: '新功能及时提醒', description: '发现新版本时展示更新说明，空闲页面自动刷新；有视频或字幕任务时，等你保存后再更新。' },
  ],
};
