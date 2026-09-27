// `export * from` a module whose declarations are ALL type-only (b.ts exports only
// an interface). Emit-verified with a real tsc build before this fixture was
// written: the compiler still keeps the require()/__exportStar call, because
// proving the target has no runtime exports would need cross-module analysis the
// star-export transform doesn't do. So this edge must stay is_type_only=0.
export * from "./b";
