import { formatDate, formatTimestamp } from './date.js';

/**
 * Rich wrapper representing an entity record retrieved from AnchorDB.
 * Provides typed accessors and formatting methods for in-storage date and computed attributes.
 */
export class EntityResult {
  public readonly name: string;
  public readonly operation: number;
  public readonly props: Record<string, number>;
  public readonly isColdTier?: boolean;

  constructor(
    name: string,
    operation: number,
    props: Record<string, number>,
    isColdTier = false,
  ) {
    this.name = name;
    this.operation = operation;
    this.props = props;
    if (isColdTier) {
      this.isColdTier = true;
    }
  }

  /**
   * Retrieves the numeric float32 value of a field (stored or dynamically computed).
   * Returns 0 if the field is not found.
   */
  public get(field: string): number {
    return this.props[field] ?? 0;
  }

  /**
   * Checks whether an attribute field is present on this record.
   */
  public has(field: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.props, field);
  }

  /**
   * Returns a copy of all stored and computed property fields.
   */
  public all(): Record<string, number> {
    return { ...this.props };
  }

  /**
   * Returns the field value formatted as an ISO "YYYY-MM-DD" date string.
   * Assumes the field stores Epoch Days.
   */
  public getDate(field: string): string {
    const val = this.props[field];
    if (val === undefined) return '';
    return formatDate(val);
  }

  /**
   * Returns the field value formatted as a "YYYY-MM-DD HH:MM:SS" UTC timestamp string.
   * Assumes the field stores Unix epoch seconds.
   */
  public getTimestamp(field: string): string {
    const val = this.props[field];
    if (val === undefined) return '';
    return formatTimestamp(val);
  }
}
