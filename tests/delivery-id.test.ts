/**
 * 交付 id 前缀单源判定（v0.9.1）的最小门。
 *
 * 守的是"第三次断裂"：星图投影 / 回填水位自愈都从这里取判定，
 * 生产者（extractor `dlv-`、l1-ingest `l1-dlv:`）改名必须同步这里，否则本文件先红。
 */
import { describe, expect, it } from 'vitest';

import { DELIVERY_ID_SQL_LIKE, deliveryIdLikeClause, isDeliveryId } from '../src/ontology/delivery-id.js';

describe('isDeliveryId', () => {
  it('两轨交付前缀都算交付', () => {
    expect(isDeliveryId('dlv-s1/2')).toBe(true);
    expect(isDeliveryId('l1-dlv:01JABC')).toBe(true);
  });

  it('步骤遥测行与空串不是交付', () => {
    expect(isDeliveryId('txn-s1/3')).toBe(false);
    expect(isDeliveryId('')).toBe(false);
    expect(isDeliveryId('ev-1')).toBe(false);
  });

  it('SQL LIKE 形态与函数判定同源（同样的两个前缀）', () => {
    expect(DELIVERY_ID_SQL_LIKE).toEqual(['dlv-%', 'l1-dlv%']);
    const { clause, params } = deliveryIdLikeClause('id');
    expect(clause).toBe('id LIKE ? OR id LIKE ?');
    expect(params).toEqual(DELIVERY_ID_SQL_LIKE);
  });
});
