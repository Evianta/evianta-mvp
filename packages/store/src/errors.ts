export class StoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class CaseNotOwnedError extends StoreError {
  constructor() {
    super(
      "The case does not exist in the requested owner scope",
      "case-not-owned",
    );
  }
}

export class InvalidCursorError extends StoreError {
  constructor() {
    super("The case pagination cursor is invalid", "invalid-cursor");
  }
}

export class SequenceConflictError extends StoreError {
  constructor() {
    super(
      "Run event sequence must increase monotonically for its case",
      "event-sequence-conflict",
    );
  }
}
