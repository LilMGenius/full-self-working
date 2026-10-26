// fsw probe <platform> <op> [arg] [--out dir]: one read operation of a surface on the operator's Chrome,
// printed as counts and field presence; scripts/probe.mjs owns the operations.
import { probe } from '../../scripts/probe.mjs';

export const run = (argv) => probe(argv);
