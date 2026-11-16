'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Check, Loader2, Save, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  checkTokenContrast,
  generateTokenPatch,
  listTokenDependents,
  rebuildTokenDependents,
  saveTokenVersion,
  type AssetDetail,
  type TokenContrastReport,
  type TokenDependent,
} from '@/lib/api/assets';
import {
  collectColorTokens,
  colorInputValue,
  setColorTokenValue,
} from '@/lib/token-colors';

export function TokenEditor({
  asset,
  onSaved,
}: {
  asset: AssetDetail;
  onSaved?: (asset: AssetDetail) => void;
}) {
  const initial = useMemo(
    () => JSON.stringify(asset.content ?? {}, null, 2),
    [asset.content],
  );
  const [text, setText] = useState(initial);
  const paletteKind =
    asset.kind === 'theme' || asset.kind === 'foundation' || asset.kind === 'style_pack';
  const editorTitle = paletteKind
    ? 'Token 编辑器'
    : asset.kind === 'component'
      ? '编辑组件'
      : asset.kind === 'animation'
        ? '编辑动效'
        : asset.kind === 'layout'
          ? '编辑布局'
          : '编辑资产';
  const [summary, setSummary] = useState(paletteKind ? 'Token 编辑' : '内容编辑');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiInput, setAiInput] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiSummary, setAiSummary] = useState('');
  const [contrast, setContrast] = useState<TokenContrastReport | null>(null);
  const [dependents, setDependents] = useState<TokenDependent[]>([]);
  const [dependentsBusy, setDependentsBusy] = useState(false);

  useEffect(() => {
    setText(initial);
    setError(null);
  }, [initial]);

  useEffect(() => {
    if (!paletteKind) return;
    let active = true;
    listTokenDependents(asset.id)
      .then((result) => {
        if (active) setDependents(result.dependents);
      })
      .catch(() => {
        // 依赖列表是辅助信息
      });
    return () => {
      active = false;
    };
  }, [asset.id, asset.version?.id, paletteKind]);

  const rebuild = async () => {
    setDependentsBusy(true);
    try {
      const result = await rebuildTokenDependents(asset.id);
      toast.success(`已更新 ${result.updated} 个依赖资产，跳过 ${result.skipped} 个`);
      const refreshed = await listTokenDependents(asset.id);
      setDependents(refreshed.dependents);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '重建依赖失败');
    } finally {
      setDependentsBusy(false);
    }
  };

  const dirty = text !== initial;
  const colorTokens = useMemo(() => {
    try {
      return collectColorTokens(JSON.parse(text));
    } catch {
      return [];
    }
  }, [text]);

  const updateColor = (path: string, value: string) => {
    const content = parseContent();
    if (!content) return;
    setText(JSON.stringify(setColorTokenValue(content, path, value), null, 2));
  };

  const format = () => {
    try {
      setText(JSON.stringify(JSON.parse(text), null, 2));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'JSON 无法解析');
    }
  };

  const parseContent = (): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Token 根节点必须是 JSON 对象');
      }
      setError(null);
      return parsed as Record<string, unknown>;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'JSON 无法解析');
      return null;
    }
  };

  const runContrast = async () => {
    const content = parseContent();
    if (!content) return;
    setAiBusy(true);
    try {
      setContrast(await checkTokenContrast(asset.id, content));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '对比度检查失败');
    } finally {
      setAiBusy(false);
    }
  };

  const runAi = async () => {
    if (aiInput.trim().length < 2) return;
    const content = parseContent();
    if (!content) return;
    setAiBusy(true);
    setError(null);
    try {
      const result = await generateTokenPatch(asset.id, content, aiInput.trim());
      setText(JSON.stringify(result.content, null, 2));
      setContrast(result.contrast);
      setAiSummary(result.rationale || result.summary);
      setAiInput('');
      toast.success('AI 已生成 Token 修改');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'AI 修改失败');
      toast.error(cause instanceof Error ? cause.message : 'AI 修改失败');
    } finally {
      setAiBusy(false);
    }
  };

  const save = async () => {
    const content = parseContent();
    if (!content) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await saveTokenVersion(asset.id, content, summary.trim() || 'Token 编辑');
      setText(JSON.stringify(updated.content ?? {}, null, 2));
      onSaved?.(updated);
      try {
        setContrast(await checkTokenContrast(updated.id, updated.content ?? {}));
      } catch {
        // 对比度报告是辅助信息
      }
      toast.success(`Token 已保存 v${updated.version?.versionNumber ?? ''}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
      toast.error(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title={asset.name}
        description={`${editorTitle} · v${asset.version?.versionNumber ?? 1}`}
      >
        <Link href="/library">
          <Button variant="outline" className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            返回资产库
          </Button>
        </Link>
        <Button variant="outline" className="gap-2" onClick={format} disabled={saving}>
          <Check className="h-4 w-4" />
          格式化
        </Button>
        <Button className="gap-2" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? '保存中…' : '保存新版本'}
        </Button>
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-4">
          {(paletteKind || colorTokens.length > 0) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">颜色 Token</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {colorTokens.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  当前 JSON 里没有 color token，或 JSON 还无法解析。
                </p>
              ) : (
                colorTokens.map((token) => {
                  const hex = colorInputValue(token.value);
                  return (
                    <div
                      key={token.path}
                      className="flex items-center gap-2 rounded-md border p-2"
                    >
                      <input
                        type="color"
                        value={hex ?? '#000000'}
                        disabled={!hex}
                        onChange={(event) => updateColor(token.path, event.target.value)}
                        className="h-8 w-10 shrink-0 cursor-pointer rounded border border-input bg-transparent p-0.5 disabled:cursor-not-allowed disabled:opacity-40"
                        aria-label={`${token.path} 颜色`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-[10px] text-muted-foreground">
                          {token.path}
                        </p>
                        <Input
                          value={token.value}
                          onChange={(event) => updateColor(token.path, event.target.value)}
                          className="mt-1 h-7 font-mono text-[11px]"
                        />
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
          )}

          <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-base">{paletteKind ? 'Token JSON' : '内容 JSON'}</CardTitle>
            {dirty && <Badge variant="outline">未保存</Badge>}
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="min-h-[560px] font-mono text-xs leading-relaxed"
              spellCheck={false}
            />
            {error && (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                {error}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
                className="h-8 w-56 text-xs"
                placeholder="版本说明"
              />
              <p className="text-[11px] text-muted-foreground">
                {paletteKind
                  ? '保存后会校验 tokenSchemaVersion、token 类型、别名和目标存在性。'
                  : '保存后会按这类资产的结构校验内容。'}
              </p>
            </div>
          </CardContent>
          </Card>
        </div>

        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4" />
                {paletteKind ? '色板' : '用到的颜色'}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {asset.palette.length ? (
                asset.palette.map((color) => (
                  <div key={color} className="flex items-center gap-2">
                    <span
                      className="h-6 w-6 shrink-0 rounded border"
                      style={{ backgroundColor: color }}
                    />
                    <code className="text-[11px] text-muted-foreground">{color}</code>
                  </div>
                ))
              ) : (
                <p className="text-xs text-muted-foreground">
                  {paletteKind ? '没有提取到颜色 token。' : '没有可显示的颜色。'}
                </p>
              )}
            </CardContent>
          </Card>

          {paletteKind && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4" />
                AI 修改
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Textarea
                value={aiInput}
                onChange={(event) => setAiInput(event.target.value)}
                placeholder="例如：把主色改深一点，保证按钮文字对比度"
                className="min-h-20 text-xs"
              />
              <Button
                size="sm"
                className="w-full gap-2"
                onClick={() => void runAi()}
                disabled={aiBusy || aiInput.trim().length < 2}
              >
                {aiBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                生成 Token 修改
              </Button>
              {aiSummary && <p className="text-[11px] text-muted-foreground">{aiSummary}</p>}
            </CardContent>
          </Card>
          )}

          {paletteKind && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-base">对比度</CardTitle>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[10px]"
                onClick={() => void runContrast()}
                disabled={aiBusy}
              >
                检查
              </Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {contrast ? (
                <>
                  <Badge
                    variant={contrast.status === 'fail' ? 'destructive' : 'outline'}
                    className={contrast.status === 'pass' ? 'text-emerald-600' : ''}
                  >
                    {contrast.status === 'pass'
                      ? '通过'
                      : contrast.status === 'fail'
                        ? '不通过'
                        : '无法判定'}
                  </Badge>
                  {contrast.checks.length === 0 && (
                    <p className="text-[11px] text-muted-foreground">没有可检查的语义颜色对。</p>
                  )}
                  {contrast.checks.map((check) => (
                    <div key={check.name} className="space-y-1 border-t pt-2 text-[11px]">
                      <div className="flex items-center justify-between gap-2">
                        <span>{check.name}</span>
                        <span
                          className={
                            check.verdict.status === 'fail'
                              ? 'text-destructive'
                              : check.verdict.status === 'pass'
                                ? 'text-emerald-600'
                                : 'text-muted-foreground'
                          }
                        >
                          {typeof check.verdict.ratio === 'number'
                            ? `${check.verdict.ratio.toFixed(2)}:1`
                            : '无法判定'}
                        </span>
                      </div>
                      <p className="font-mono text-[10px] text-muted-foreground">
                        {check.foregroundValue} on {check.backgroundValue}
                      </p>
                    </div>
                  ))}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  检查正文/页面、正文/表面、按钮文字/主色、次要文字/表面四组颜色。
                </p>
              )}
            </CardContent>
          </Card>
          )}

          {paletteKind && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-base">依赖资产</CardTitle>
              {dependents.some((item) => item.outdated) && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[10px]"
                  onClick={() => void rebuild()}
                  disabled={dependentsBusy}
                >
                  {dependentsBusy ? '同步中…' : '同步旧依赖'}
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-2">
              {dependents.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  还没有组件/布局钉住这个 Token 版本。
                </p>
              ) : (
                dependents.map((item) => (
                  <div
                    key={item.documentId}
                    className="flex items-center justify-between gap-2 border-b pb-2 last:border-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium">{item.name}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {item.kind} · v{item.versionNumber}
                      </p>
                    </div>
                    <Badge
                      variant={item.outdated ? 'outline' : 'secondary'}
                      className="shrink-0 text-[10px]"
                    >
                      {item.outdated ? '旧 Token' : '当前'}
                    </Badge>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">保存行为</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-muted-foreground">
              <p>保存会创建不可变新版本，不会覆盖旧版本。</p>
              {paletteKind ? (
                <>
                  <p>依赖这个主题的组件和布局不会自动重建，它们仍指向旧版本。</p>
                  <p>主题在资产库里用色板检查，没有组件那样的实时预览。</p>
                </>
              ) : (
                <p>组件和动效可以回到资产库看实时预览。</p>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
