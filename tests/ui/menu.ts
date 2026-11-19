import { expect, type Locator } from "@playwright/test";

/** Choose through the visible Fluent menu, including its checked state. */
export async function chooseMenu(trigger: Locator, value: string) {
  await trigger.click();
  const item = trigger
    .page()
    .getByRole("menuitemradio")
    .and(trigger.page().locator(`[data-value=${JSON.stringify(value)}]`));
  await expect(item).toBeVisible();
  await item.click();
  await expect(trigger.page().getByRole("menu")).toHaveCount(0);
}

export async function expectMenuOptions(trigger: Locator, labels: string[]) {
  await trigger.click();
  await expect(trigger.page().getByRole("menuitemradio")).toHaveText(labels);
  await trigger.page().keyboard.press("Escape");
  await expect(trigger).toBeFocused();
}
