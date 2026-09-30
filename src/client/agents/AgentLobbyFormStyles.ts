import { css } from "lit";

export const agentLobbyFormStyles = css`
  :host {
    display: block;
    color: #f1f3f5;
  }
  .intro {
    color: #becbd7;
    line-height: 1.5;
    margin: 0 0 20px;
  }
  fieldset {
    border: 0;
    padding: 0;
    min-width: 0;
  }
  fieldset:disabled {
    opacity: 0.65;
  }
  .agent-seats {
    background: #ffffff06;
    border: 1px solid #ffffff18;
    border-radius: 12px;
    padding: 18px;
    margin-bottom: 24px;
  }
  .agent-seats h3 {
    font-size: 16px;
    font-weight: 700;
    margin: 0 0 16px;
  }
  .seat-inputs {
    display: grid;
    align-items: end;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }
  .seat-inputs label {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-weight: 600;
  }
  .seat-inputs input {
    width: 100%;
    background: #101b28;
    color: #fff;
    border: 1px solid #6e859b;
    border-radius: 7px;
    padding: 10px;
    font-size: 16px;
  }
  .agent-seats p,
  footer p {
    font-size: 12px;
    color: #b2c2d1;
    line-height: 1.5;
    margin-top: 12px;
  }
  game-config-settings {
    display: block;
  }
  footer {
    position: sticky;
    bottom: -16px;
    z-index: 5;
    background: #18222cf7;
    border-top: 1px solid #ffffff25;
    padding: 12px 0 16px;
    margin-top: 8px;
  }
  footer p {
    margin: 0 0 10px;
  }
  .role-buttons {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .role-buttons button {
    color: #fff;
    font-weight: 700;
    border-radius: 8px;
    padding: 13px 10px;
    border: 1px solid #5ca6d0;
  }
  .primary {
    background: #067bb6;
  }
  .secondary {
    background: #263b50;
  }
  button:disabled {
    cursor: default;
  }
  button:focus-visible,
  input:focus-visible,
  select:focus-visible {
    outline: 2px solid #83ceff;
    outline-offset: 3px;
  }
  /* Keep native map loading placeholders static. */
  .animate-pulse {
    animation: none !important;
  }
  @media (max-width: 520px) {
    .seat-inputs {
      gap: 12px;
    }
    .agent-seats {
      padding: 14px;
    }
    game-config-settings section > div:first-child {
      flex-wrap: wrap;
      gap: 10px;
    }
    game-config-settings section > div:first-child h3 {
      font-size: 15px;
    }
    game-config-settings section > div:first-child > div:last-child {
      margin-left: 0;
    }
    game-config-settings input[type="text"] {
      width: 100%;
    }
    footer {
      bottom: -12px;
    }
    .role-buttons {
      gap: 8px;
    }
  }
`;
