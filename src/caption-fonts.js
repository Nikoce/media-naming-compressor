const sans = 'Arial, "PingFang SC", "Microsoft YaHei", sans-serif';
const serif = 'Georgia, "Songti SC", SimSun, serif';
const mono = 'Menlo, Consolas, "PingFang SC", "Microsoft YaHei", monospace';

export const CAPTION_FONTS = [
  { id: 'sans', label: '无衬线（默认）', family: sans },
  { id: 'serif', label: '衬线', family: serif },
  { id: 'mono', label: '等宽', family: mono },
  { id: 'yahei', label: '微软雅黑', family: `"Microsoft YaHei", "PingFang SC", ${sans}` },
  { id: 'simhei', label: '黑体', family: `SimHei, "Heiti SC", ${sans}` },
  { id: 'simsun', label: '宋体', family: `SimSun, "Songti SC", ${serif}` },
  { id: 'kaiti', label: '楷体', family: `KaiTi, STKaiti, "Kaiti SC", ${serif}` },
  { id: 'fangsong', label: '仿宋', family: `FangSong, STFangsong, ${serif}` },
  { id: 'pingfang', label: '苹方', family: `"PingFang SC", "Microsoft YaHei", ${sans}` },
  { id: 'arial', label: 'Arial', family: `Arial, ${sans}` },
  { id: 'helvetica', label: 'Helvetica', family: `Helvetica, Arial, ${sans}` },
  { id: 'verdana', label: 'Verdana', family: `Verdana, ${sans}` },
  { id: 'times', label: 'Times New Roman', family: `"Times New Roman", Times, ${serif}` },
  { id: 'georgia', label: 'Georgia', family: serif },
  { id: 'impact', label: 'Impact', family: `Impact, "Arial Black", ${sans}` },
  { id: 'consolas', label: 'Consolas', family: `Consolas, Menlo, ${mono}` },
];

export function captionFontFamily(id) {
  return CAPTION_FONTS.find((font) => font.id === id)?.family || sans;
}
