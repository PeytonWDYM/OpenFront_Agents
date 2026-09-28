import { css } from "lit";

export const agentPanelStyles = css`
  :host {
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 12000;
    font:
      14px system-ui,
      sans-serif;
    color: #f1f3f5;
    max-width: calc(100vw - 24px);
  }
  * {
    box-sizing: border-box;
  }
  .panel {
    width: 360px;
    max-width: calc(100vw - 24px);
    max-height: calc(100dvh - 24px);
    display: flex;
    flex-direction: column;
    background: #18222c;
    border: 1px solid #566474;
    border-radius: 10px;
    box-shadow: 0 4px 18px #0005;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px;
    border-bottom: 1px solid #ffffff24;
  }
  h2,
  h3 {
    margin: 0;
    font-size: 16px;
  }
  .body {
    overflow-y: auto;
    padding: 12px;
    overscroll-behavior: contain;
  }
  button,
  input,
  select {
    font: inherit;
    color: inherit;
    border: 1px solid #637182;
    border-radius: 6px;
    background: #253343;
  }
  button {
    cursor: pointer;
    padding: 8px 10px;
  }
  button:hover:not(:disabled) {
    background: #36495d;
  }
  button:disabled {
    cursor: default;
    opacity: 0.5;
  }
  button:focus-visible,
  input:focus-visible,
  select:focus-visible,
  summary:focus-visible {
    outline: 2px solid #9be2a9;
    outline-offset: 2px;
  }
  .entry,
  .primary {
    background: #276d3c;
    border-color: #68a475;
  }
  .primary {
    width: 100%;
    margin-top: 12px;
  }
  .toolbar {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin: 10px 0;
  }
  fieldset {
    margin: 0;
    padding: 0;
    border: 0;
  }
  label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 10px;
  }
  input {
    width: 110px;
    padding: 6px;
  }
  select {
    max-width: 190px;
    padding: 6px;
  }
  details {
    margin-top: 14px;
  }
  summary {
    cursor: pointer;
  }
  .muted {
    color: #bcc7d1;
    font-size: 12px;
    line-height: 1.5;
  }
  .error {
    color: #ffb4af;
    overflow-wrap: anywhere;
  }
  .status {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
  .players {
    list-style: none;
    padding: 0;
    margin: 12px 0 0;
  }
  .players li + li {
    margin-top: 6px;
  }
  .player {
    width: 100%;
    text-align: left;
    padding: 10px;
  }
  .player-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .player-status {
    font-size: 11px;
    color: #a5d7b3;
  }
  .player-status.dead {
    color: #bcc7d1;
  }
  .player .muted {
    display: block;
    margin-top: 5px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .thread-id {
    overflow-wrap: anywhere;
    font-family: monospace;
  }
  .transcript-event {
    border-top: 1px solid #ffffff24;
    padding-top: 9px;
    margin-top: 12px;
  }
  .event-meta {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    color: #bcc7d1;
    font-size: 11px;
  }
  pre {
    font:
      12px/1.5 ui-monospace,
      monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin-bottom: 0;
    user-select: text;
  }
  @media (max-width: 600px) {
    :host {
      top: 6px;
      right: 6px;
    }
    .panel {
      max-height: calc(100dvh - 12px);
      width: 320px;
    }
  }
`;
