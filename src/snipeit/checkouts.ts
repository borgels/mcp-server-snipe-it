import type { SnipeItClient } from './client.js';
import { assertWritesEnabled } from './policy.js';

export type CheckoutType = 'asset' | 'accessory' | 'consumable' | 'component' | 'license';

export interface CheckoutInput {
  type: CheckoutType;
  id: number;
  /** user | asset | location — target kind. Consumables/accessories go to users; components go to assets. */
  targetType?: 'user' | 'asset' | 'location';
  targetId?: number;
  quantity?: number;
  statusId?: number;
  seatId?: number;
  expectedCheckin?: string;
  note?: string;
}

export async function checkout(client: SnipeItClient, input: CheckoutInput): Promise<unknown> {
  assertWritesEnabled('snipeit_checkout');

  switch (input.type) {
    case 'asset': {
      const targetType = input.targetType ?? 'user';
      requireTarget(input);
      const body: Record<string, unknown> = {
        checkout_to_type: targetType,
        status_id: input.statusId,
        expected_checkin: input.expectedCheckin,
        note: input.note,
      };
      body[targetType === 'user' ? 'assigned_user' : targetType === 'asset' ? 'assigned_asset' : 'assigned_location'] =
        input.targetId;
      return client.post(`/hardware/${input.id}/checkout`, body);
    }

    case 'accessory': {
      requireTarget(input);
      const targetType = input.targetType ?? 'user';
      return client.post(`/accessories/${input.id}/checkout`, {
        checkout_to_type: targetType,
        assigned_user: targetType === 'user' ? input.targetId : undefined,
        assigned_asset: targetType === 'asset' ? input.targetId : undefined,
        assigned_location: targetType === 'location' ? input.targetId : undefined,
        checkout_qty: input.quantity ?? 1,
        note: input.note,
      });
    }

    case 'consumable': {
      requireTarget(input);
      if (input.targetType && input.targetType !== 'user') {
        throw new Error('Consumables can only be checked out to users.');
      }
      // NOTE: consumable checkout is IRREVERSIBLE — stock only decrements.
      return client.post(`/consumables/${input.id}/checkout`, {
        assigned_to: input.targetId,
        checkout_qty: input.quantity ?? 1,
        note: input.note,
      });
    }

    case 'component': {
      requireTarget(input);
      if (input.targetType && input.targetType !== 'asset') {
        throw new Error('Components can only be checked out to assets.');
      }
      return client.post(`/components/${input.id}/checkout`, {
        assigned_to: input.targetId,
        assigned_qty: input.quantity ?? 1,
        note: input.note,
      });
    }

    case 'license': {
      requireTarget(input);
      const targetType = input.targetType ?? 'user';
      if (targetType === 'location') {
        throw new Error('Licenses check out to users or assets, not locations.');
      }
      return client.post(`/licenses/${input.id}/checkout`, {
        target_type: targetType,
        assigned_to: targetType === 'user' ? input.targetId : undefined,
        asset_id: targetType === 'asset' ? input.targetId : undefined,
        seat_id: input.seatId,
        notes: input.note,
      });
    }

    default:
      throw new Error(`Unknown checkout type: ${String(input.type)}`);
  }
}

export interface CheckinInput {
  type: Exclude<CheckoutType, 'consumable'>;
  /**
   * asset/license: the entity id.
   * accessory: the AccessoryCheckout PIVOT-ROW id (from include=checkedout).
   * component: the components_assets PIVOT-ROW id (from include=assets).
   */
  id: number;
  quantity?: number;
  seatId?: number;
  locationId?: number;
  statusId?: number;
  note?: string;
}

export async function checkin(client: SnipeItClient, input: CheckinInput): Promise<unknown> {
  assertWritesEnabled('snipeit_checkin');

  switch (input.type) {
    case 'asset':
      return client.post(`/hardware/${input.id}/checkin`, {
        location_id: input.locationId,
        status_id: input.statusId,
        note: input.note,
      });

    case 'accessory':
      return client.post(`/accessories/${input.id}/checkin`, { note: input.note });

    case 'component':
      return client.post(`/components/${input.id}/checkin`, {
        checkin_qty: input.quantity ?? 1,
        note: input.note,
      });

    case 'license': {
      if (!input.seatId) {
        throw new Error('seatId is required for license checkin (see snipeit_get_entity licenses include=seats).');
      }
      // NOTE: checking in a seat on a non-reassignable license burns the seat.
      return client.post(`/licenses/${input.id}/checkin`, {
        seat_id: input.seatId,
        notes: input.note,
      });
    }

    default:
      throw new Error(`Unknown checkin type: ${String(input.type)} (consumables cannot be checked in).`);
  }
}

function requireTarget(input: CheckoutInput): void {
  if (input.targetId === undefined) {
    throw new Error('targetId is required for checkout.');
  }
}
