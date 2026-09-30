export interface TranscriptPosition {
  key: string;
  offset: number;
}

export function followsLatest(body: HTMLElement): boolean {
  return body.scrollHeight - body.clientHeight - body.scrollTop < 32;
}

/** Preserve the first visible row when the retained history window advances. */
export function captureTranscriptPosition(
  body: HTMLElement,
): TranscriptPosition | undefined {
  const top = body.getBoundingClientRect().top;
  const row = [...body.querySelectorAll<HTMLElement>("[data-event-key]")].find(
    (event) => event.getBoundingClientRect().bottom > top,
  );
  return row
    ? {
        key: row.dataset.eventKey!,
        offset: row.getBoundingClientRect().top - top,
      }
    : undefined;
}

export function restoreTranscriptPosition(
  body: HTMLElement,
  position: TranscriptPosition,
): void {
  const row = [...body.querySelectorAll<HTMLElement>("[data-event-key]")].find(
    (event) => event.dataset.eventKey === position.key,
  );
  if (row) {
    body.scrollTop +=
      row.getBoundingClientRect().top -
      body.getBoundingClientRect().top -
      position.offset;
  }
}
