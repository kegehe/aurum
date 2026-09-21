/**
 * 提示词模板集中管理
 *
 * 所有发给大模型的提示词都在这里，方便迭代调优。
 */
import type { StyleProfile } from './types';
import { DEFAULT_VARIATION_COUNT } from './types';

/**
 * 样式分析提示词
 *
 * 核心要求：只看样式、不看内容；颜色必须使用像素检测出的 HEX，不得自行发明。
 */
export function buildStyleAnalysisPrompt(detectedColors: string[]): string {
  const colorList = detectedColors.map((c) => `- ${c}`).join('\n');
  return `你是资深视觉设计师。分析这张图片的视觉样式，输出结构化样式档案。

## 铁律：只看样式，不看内容
- 忽略图中人物身份、文字含义、产品品牌、具体物品、场景语义
- 把一切文字当作"排版标本"来读（字号/字重/字体气质/行距/字距），不读它说了什么
- 把图片当作颜色块、形状、空间关系来读

## 颜色必须精确（最重要）
图片像素已用程序提取出主导颜色，全部列在下方。这是唯一可信的色值来源：
${colorList}
- colorPalette 中的所有 hex 必须严格来自这个列表，禁止自行发明新 HEX
- 从列表中挑选/组织：主色、背景色、强调色、完整色板 scale（按占比或视觉重要性排序）
- 色值以外的判断（什么色、什么情绪、什么风格）可以自由发挥

## 输出要求
按 schema 输出以下维度，语言精炼、专业、可操作：
1. colorPalette：主色/背景/强调色（必须引用上述 HEX）+ 完整色板 + 色彩情绪一句话
2. typography：字体家族气质（如"高对比几何无衬线"）、建议字体名（如有把握）、字重层级、
   字号层级（每级给 px 与字重）、行高
3. spacing：基础间距单位、间距刻度、密度（compact/comfortable/loose）
4. layout：整体构图一句话、主要区域划分、栅格（如有）、视觉重心/平衡
5. textureMood：圆角、阴影、渐变（无则 null）、视觉密度、3-8 个风格关键词
6. styleGuideText：一段 100-200 字的设计风格描述（像写设计 brief，可给设计师/其它 AI 用）

判断不准的字段，给合理推断并保持 schema 完整，不要省略。`;
}

/**
 * 变体生成提示词
 *
 * 用 StyleProfile 的 token 生成多种"不同构图、相同样式"的自包含 HTML/CSS mockup。
 * 内容用占位符，只展示样式。
 */
export function buildVariationGenerationPrompt(profile: StyleProfile): string {
  const profileJson = JSON.stringify(profile, null, 2);
  return `你是资深前端实现工程师。基于给定的样式档案，生成 ${DEFAULT_VARIATION_COUNT} 种"不同构图、完全一致样式"的页面 mockup。

## 样式档案（JSON，必须严格使用其中数值）
${profileJson}

## 硬性要求
- 每种变体必须使用**完全相同的样式 token**：颜色用档案中的 HEX、字号/字重/行高用 typography.hierarchy、间距用 spacing.scale、圆角/阴影用 textureMood
- 每种变体是**不同的布局构图**，且构图差异明显（如：居中 Hero / 左右分栏 / 杂志式网格 / 仪表盘导航 等），名称用中文
- 每个 html 是**自包含单文件**：内联 <style>，无外部资源（禁止 CDN 字体/图片/脚本），字体用系统字体栈
- 内容一律用占位符（标题/段落/按钮/图片色块），内容无关紧要，重点是展示样式
- 每个 html 尺寸控制在 800×600 左右，响应式可缩放的页面骨架即可，不需要完整产品
- html 用中文文本占位，简洁，总大小尽量控制在 1-2KB 内
- composition 字段用 1-2 句话描述该构图的布局结构（给 AI 生图用，如"居中大标题 hero，下方两列卡片，顶部细导航"）

输出每个变体的：name、description（给用户的一句话说明）、composition（构图结构）、html（完整源码）。`;
}
