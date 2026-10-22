// Types for cardMatching.cjs, so the renderer can import it from TypeScript.
export declare const BASIC_LANDS: Set<string>
export declare const BASIC_WEIGHT: number
export declare function weightFor(name: string): number
export declare function countByName(names: Array<string | null | undefined>): Map<string, number>
export declare function containment(
  observedCounts: Map<string, number>,
  poolCounts: Map<string, number>,
): number
