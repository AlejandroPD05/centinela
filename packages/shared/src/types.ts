/**
 * Vocabulario compartido entre el motor de checks, la API y las interfaces.
 *
 * Aquí no hay dependencias: tipos y constantes puras que viajan igual de bien
 * al backend que al panel.
 */

export const monitorTypes = ['http', 'tcp', 'heartbeat'] as const;
export type MonitorType = (typeof monitorTypes)[number];

/**
 * Resultado de un check individual.
 * `degraded` es un servicio arriba pero lento: cuenta como disponible.
 */
export const checkStatuses = ['up', 'degraded', 'down', 'error'] as const;
export type CheckStatus = (typeof checkStatuses)[number];

/** Estado agregado de un monitor tras aplicar los umbrales de confirmación. */
export const monitorStates = ['pending', 'up', 'degraded', 'down'] as const;
export type MonitorState = (typeof monitorStates)[number];

/** Roles dentro de un espacio de trabajo. */
export const roles = ['admin', 'editor', 'viewer'] as const;
export type Role = (typeof roles)[number];
