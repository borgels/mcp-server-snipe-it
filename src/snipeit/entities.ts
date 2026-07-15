/**
 * Generic entity catalog: every standard Laravel resource in Snipe-IT with
 * index/show/create/update, plus the subresources each one exposes.
 * Assets (hardware) have richer dedicated tools and are not listed here.
 */
export interface EntityDefinition {
  path: string;
  label: string;
  /** Allowed `include` values on get: subresource path segments. */
  subresources: string[];
}

export const ENTITIES = {
  licenses: { path: '/licenses', label: 'Licenses', subresources: ['seats', 'history'] },
  accessories: { path: '/accessories', label: 'Accessories', subresources: ['checkedout', 'history'] },
  consumables: { path: '/consumables', label: 'Consumables', subresources: ['users', 'history'] },
  components: { path: '/components', label: 'Components', subresources: ['assets', 'history'] },
  users: { path: '/users', label: 'Users', subresources: ['assets', 'accessories', 'licenses', 'history'] },
  locations: {
    path: '/locations',
    label: 'Locations',
    subresources: ['users', 'assets', 'assigned/assets', 'assigned/accessories', 'history'],
  },
  statuslabels: { path: '/statuslabels', label: 'Status labels', subresources: ['assetlist'] },
  categories: { path: '/categories', label: 'Categories', subresources: [] },
  manufacturers: { path: '/manufacturers', label: 'Manufacturers', subresources: [] },
  models: { path: '/models', label: 'Asset models', subresources: ['history'] },
  companies: { path: '/companies', label: 'Companies', subresources: [] },
  departments: { path: '/departments', label: 'Departments', subresources: [] },
  suppliers: { path: '/suppliers', label: 'Suppliers', subresources: [] },
  fields: { path: '/fields', label: 'Custom fields', subresources: [] },
  fieldsets: { path: '/fieldsets', label: 'Fieldsets', subresources: ['fields'] },
  kits: { path: '/kits', label: 'Predefined kits', subresources: ['licenses', 'models', 'accessories', 'consumables'] },
  maintenances: { path: '/maintenances', label: 'Asset maintenances', subresources: ['history', 'notes'] },
  depreciations: { path: '/depreciations', label: 'Depreciations', subresources: [] },
  groups: { path: '/groups', label: 'Permission groups', subresources: [] },
} as const satisfies Record<string, EntityDefinition>;

export type EntityName = keyof typeof ENTITIES;

export const ENTITY_NAMES = Object.keys(ENTITIES) as [EntityName, ...EntityName[]];

/** Entities where create/update via the generic write tools is allowed. */
export const WRITABLE_ENTITIES = new Set<EntityName>([
  'licenses',
  'accessories',
  'consumables',
  'components',
  'users',
  'locations',
  'statuslabels',
  'categories',
  'manufacturers',
  'models',
  'companies',
  'departments',
  'suppliers',
  'maintenances',
]);

export function entityDefinition(name: string): EntityDefinition {
  const definition = (ENTITIES as Record<string, EntityDefinition>)[name];
  if (!definition) {
    throw new Error(`Unknown entity: ${name}. Valid: ${ENTITY_NAMES.join(', ')}`);
  }
  return definition;
}
