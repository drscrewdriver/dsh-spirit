/**
 * 入库前置脱敏（TA.3）：正反成对——各类机密命中即丢，正常句不误伤（假阳取严但不失控）。
 */
import { describe, expect, it } from 'vitest';

import { containsSecret, dropIfSecret } from '../src/ontology/scrub.js';

describe('containsSecret 命中即判含密', () => {
  it.each([
    '配置里写 sk-abcdefghijklmnopqrstuvwxyz1234 就能连',
    'AWS key AKIAABCDEFGHIJKLMNOP 泄露了',
    'google AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
    'github token ghp_abcdefghijklmnopqrstuvwxyz123456',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    '-----BEGIN RSA PRIVATE KEY-----',
    'password=hunter2secretsecret',
    'connect redis://admin:p@ssw0rd@cache.internal:6379',
    '身份证 11010119900307123X 登记',
    '手机 13800138000 联系',
  ])('命中丢弃：%s', (text) => {
    expect(containsSecret(text)).toBe(true);
    expect(dropIfSecret(text)).toBeNull();
  });
});

describe('正常句不误伤（假阳不能把日常内容全丢了）', () => {
  it.each([
    '帮用户把 dsh-spirit 的发布流程理清并发了 0.4.0',
    '这轮跑了 vitest，610 个测试通过',
    '他说上次干的不错，让我继续推进本体层',
    '端口 3080 上挂着 webServer，路径 e:/test/rewrite-agently',
    '上周的事：经手了事务轨采集，下一步做实体注册表',
    '时间戳 1700000000000 与轮次 12 只是排序用',
  ])('放行：%s', (text) => {
    expect(containsSecret(text)).toBe(false);
    expect(dropIfSecret(text)).toBe(text);
  });

  it('空串不含密（不误判为需丢弃）', () => {
    expect(containsSecret('')).toBe(false);
  });
});
