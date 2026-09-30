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
    text-align: left;
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
    overflow: hidden;
    background: #18222c;
    border: 1px solid #566474;
    border-radius: 10px;
    box-shadow: 0 4px 18px #0005;
  }
  .panel-header {
    flex: 0 0 auto;
    padding: 12px;
    border-bottom: 1px solid #ffffff24;
    background: #1b2834;
  }
  .panel.inspecting {
    height: calc(100dvh - 24px);
  }
  .header-main,
  .header-summary,
  .player-head,
  .event-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .header-heading {
    min-width: 0;
  }
  .eyebrow,
  .header-model {
    display: block;
    color: #aebdcb;
    font-size: 11px;
    line-height: 1.5;
  }
  .eyebrow {
    margin-bottom: 2px;
  }
  h2 {
    margin: 0;
    font-size: 17px;
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .header-summary {
    margin-top: 12px;
    align-items: flex-start;
  }
  .phase-badge,
  .player-status {
    border: 1px solid #75908755;
    border-radius: 4px;
    color: #badbc3;
    background: #28403955;
    padding: 3px 6px;
    font-size: 10px;
    line-height: 1.3;
  }
  .phase-badge {
    flex-shrink: 0;
  }
  .usage {
    color: #f1f3f5;
    font-size: 13px;
    font-weight: 600;
    text-align: right;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
  .header-model {
    margin-top: 6px;
  }
  .usage-breakdown {
    margin-top: 8px;
  }
  .usage-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 6px 12px;
    margin: 10px 0;
    font-size: 12px;
    line-height: 1.4;
  }
  .usage-grid dd {
    margin: 0;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: #e0e8ef;
  }
  .usage-subset {
    padding-left: 10px;
    color: #bcc7d1;
    font-size: 11px;
  }
  .usage-note {
    margin: 6px 0 0;
    color: #aebdcb;
    font-size: 11px;
    line-height: 1.4;
  }
  .header-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0 10px;
  }
  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 12px;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
    overflow-anchor: none;
  }
  button,
  input {
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
  summary:focus-visible {
    outline: 2px solid #9be2a9;
    outline-offset: 2px;
  }
  .hide-control {
    flex-shrink: 0;
    font-size: 12px;
    padding: 6px 9px;
  }
  .back-control {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-top: 10px;
    padding: 3px 0;
    border: 0;
    background: transparent;
    font-size: 12px;
    color: #bfdac8;
  }
  .back-control:hover:not(:disabled) {
    background: transparent;
    color: #effff3;
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
    margin-top: 10px;
  }
  .toolbar button {
    font-size: 12px;
    padding: 7px 9px;
  }
  .thread-controls {
    padding-top: 10px;
    border-top: 1px solid #ffffff18;
  }
  .diagnostics-control {
    margin: 0;
    width: 100%;
    justify-content: flex-start;
    color: #bcc7d1;
    font-size: 12px;
  }
  .diagnostics-control input {
    width: auto;
  }
  .stop-control {
    color: #ffcfca;
  }
  .role-buttons {
    display: flex;
    gap: 8px;
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
  input[type="range"] {
    width: 100%;
    padding: 0;
    margin-top: 8px;
  }
  .muted,
  .join-status {
    color: #bcc7d1;
    font-size: 12px;
    line-height: 1.5;
  }
  .join-status {
    margin: 8px 0 0;
  }
  .auth-status {
    margin-top: 0;
  }
  .error {
    color: #ffb4af;
    overflow-wrap: anywhere;
    font-size: 12px;
    line-height: 1.5;
  }
  summary {
    cursor: pointer;
    color: #b9c9d7;
    font-size: 11px;
  }
  .panel-info,
  .thread-info {
    margin-bottom: 12px;
  }
  .panel-info p,
  .thread-info p {
    margin: 8px 0 0;
  }
  .players {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .players li + li {
    margin-top: 8px;
  }
  .player {
    display: block;
    width: 100%;
    text-align: left;
    padding: 11px;
    border-color: #526372;
    background: #24323f;
  }
  .player-head strong {
    min-width: 0;
    overflow-wrap: anywhere;
    font-size: 13px;
  }
  .player-status {
    flex-shrink: 0;
  }
  .player-status.dead {
    color: #bcc7d1;
    background: #ffffff08;
    border-color: #ffffff24;
  }
  .player-stats {
    display: grid;
    grid-template-columns: auto auto minmax(0, 1fr);
    gap: 8px;
    margin-top: 10px;
    color: #b9c9d7;
    font-size: 11px;
    line-height: 1.4;
    font-variant-numeric: tabular-nums;
  }
  .player-usage {
    text-align: right;
    color: #e0e8ef;
  }
  .last-action {
    display: block;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid #ffffff14;
    color: #b9c9d7;
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .player .error {
    display: block;
    margin-top: 8px;
  }
  .thread-id {
    overflow-wrap: anywhere;
    font:
      11px/1.5 ui-monospace,
      monospace;
  }
  .transcript-event {
    border: 1px solid #ffffff1f;
    background: #21303d;
    border-radius: 6px;
    padding: 10px;
  }
  .transcript-event + .transcript-event {
    margin-top: 8px;
  }
  .event-meta {
    align-items: flex-start;
    font-size: 10px;
    line-height: 1.4;
  }
  .event-type {
    min-width: 0;
    color: #c4dfd0;
    overflow-wrap: anywhere;
  }
  .event-meta time {
    color: #91a5b8;
    flex-shrink: 0;
  }
  .event-preview {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    overflow: hidden;
    color: #d4dfe8;
    font-size: 12px;
    line-height: 1.5;
    margin: 8px 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .event-details summary {
    color: #98b2c6;
  }
  .vision-preview {
    width: 100%;
    aspect-ratio: 4 / 3;
    margin-top: 8px;
    border: 1px solid #ffffff24;
    border-radius: 4px;
    overflow: hidden;
    background: #14202b;
  }
  .vision-image {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  pre {
    max-height: 360px;
    overflow: auto;
    font:
      11px/1.5 ui-monospace,
      monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 8px 0 0;
    color: #b9c9d7;
    user-select: text;
  }
  @media (max-width: 600px) {
    :host {
      top: 6px;
      right: 6px;
      max-width: calc(100vw - 12px);
    }
    .panel {
      max-height: calc(100dvh - 12px);
      max-width: calc(100vw - 12px);
      width: 320px;
    }
    .panel.inspecting {
      height: calc(100dvh - 12px);
    }
    .panel-header,
    .body {
      padding: 10px;
    }
    .player-stats {
      gap: 6px;
      font-size: 10px;
    }
    .toolbar button {
      padding: 7px 8px;
    }
  }
`;
