import { ComputeOp } from './types.js';

/**
 * Creates an in-storage division operator (fieldA / fieldB).
 * Either field can be an attribute name or stringified numeric literal.
 */
export function divide(fieldA: string, fieldB: string): ComputeOp {
  return { type: 'divide', fieldA, fieldB };
}

/**
 * Creates an in-storage multiplication operator (fieldA * fieldB).
 */
export function multiply(fieldA: string, fieldB: string): ComputeOp {
  return { type: 'multiply', fieldA, fieldB };
}

/**
 * Creates an in-storage addition operator (fieldA + fieldB).
 */
export function add(fieldA: string, fieldB: string): ComputeOp {
  return { type: 'add', fieldA, fieldB };
}

/**
 * Creates an in-storage addition operator adding a numeric constant to an attribute (field + val).
 */
export function addConst(field: string, val: number): ComputeOp {
  return { type: 'add', fieldA: field, fieldB: String(val) };
}

/**
 * Creates an in-storage subtraction operator (fieldA - fieldB).
 */
export function subtract(fieldA: string, fieldB: string): ComputeOp {
  return { type: 'subtract', fieldA, fieldB };
}

/**
 * Creates an in-storage subtraction operator subtracting a numeric constant from an attribute (field - val).
 */
export function subtractConst(field: string, val: number): ComputeOp {
  return { type: 'subtract', fieldA: field, fieldB: String(val) };
}

/**
 * Creates an in-storage multiplication operator multiplying an attribute by a numeric constant (field * val).
 */
export function multiplyConst(field: string, val: number): ComputeOp {
  return { type: 'multiply', fieldA: field, fieldB: String(val) };
}

/**
 * Creates an in-storage division operator dividing an attribute by a numeric constant (field / val).
 */
export function divideConst(field: string, val: number): ComputeOp {
  return { type: 'divide', fieldA: field, fieldB: String(val) };
}

/**
 * Directly assigns a constant numeric value to a field.
 */
export function value(val: number): ComputeOp {
  return { type: 'assign', value: String(val) };
}

/**
 * Assigns a literal value or copies another attribute field.
 */
export function assign(valueOrField: string): ComputeOp {
  return { type: 'assign', value: valueOrField };
}

/**
 * Creates an in-storage operator to add N days to a date field.
 */
export function addDays(field: string, days: number): ComputeOp {
  return { type: 'addDays', field, days };
}

/**
 * Creates an in-storage operator to subtract N days from a date field.
 */
export function subtractDays(field: string, days: number): ComputeOp {
  return { type: 'subtractDays', field, days };
}

/**
 * Creates an in-storage operator to calculate days between fieldA and fieldB (fieldA - fieldB).
 */
export function daysBetween(fieldA: string, fieldB: string): ComputeOp {
  return { type: 'daysBetween', fieldA, fieldB };
}
