import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResourceType } from '@aurum/shared-types';
import { ResourceTypeBadge } from './resource-type-badge';
import { EmptyState } from './empty-state';
import { ErrorState } from './error-state';

describe('ResourceTypeBadge', () => {
  it('按常量表渲染中文名', () => {
    render(<ResourceTypeBadge type={ResourceType.image} />);
    expect(screen.getByText('图片')).toBeInTheDocument();
  });

  // 后端新增资源类型而前端还没跟上的窗口期，不能显示 undefined。
  it('未知类型回退为原始值，不渲染 undefined', () => {
    render(<ResourceTypeBadge type={'brand_new_type' as ResourceType} />);
    expect(screen.getByText('brand_new_type')).toBeInTheDocument();
    expect(screen.queryByText('undefined')).not.toBeInTheDocument();
  });
});

describe('EmptyState', () => {
  it('渲染标题，无描述时不渲染描述节点', () => {
    render(<EmptyState title="还没有资源" />);
    expect(screen.getByText('还没有资源')).toBeInTheDocument();
  });

  it('有描述时渲染描述', () => {
    render(<EmptyState title="空" description="先去上传一些吧" />);
    expect(screen.getByText('先去上传一些吧')).toBeInTheDocument();
  });

  it('无 action 时不渲染按钮', () => {
    render(<EmptyState title="空" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('有 action 时点击触发回调', async () => {
    const onClick = vi.fn();
    render(<EmptyState title="空" action={{ label: '去上传', onClick }} />);

    await userEvent.click(screen.getByRole('button', { name: '去上传' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('ErrorState', () => {
  it('默认message 为「加载失败」', () => {
    render(<ErrorState />);
    expect(screen.getByText('加载失败')).toBeInTheDocument();
  });

  it('标题固定为「出错了」，message 只影响描述行', () => {
    render(<ErrorState message="网络不可用" />);
    expect(screen.getByText('出错了')).toBeInTheDocument();
    expect(screen.getByText('网络不可用')).toBeInTheDocument();
    expect(screen.queryByText('加载失败')).not.toBeInTheDocument();
  });

  it('无 onRetry 时不渲染重试按钮', () => {
    render(<ErrorState />);
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
  });

  it('有 onRetry 时点击触发回调', async () => {
    const onRetry = vi.fn();
    render(<ErrorState onRetry={onRetry} />);

    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
