import {
  Button,
  Menu,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  type ButtonProps,
} from "@fluentui/react-components";
import { ChevronDown16Regular } from "@fluentui/react-icons";
import type { ComponentPropsWithoutRef } from "react";

export type MenuOption = {
  value: string | number;
  label: string;
  disabled?: boolean;
};

/** A single selection presented through the standard Fluent menu. */
export function MenuSelect({
  value,
  options,
  placeholder,
  onChange,
  className = "",
  ...props
}: Omit<ComponentPropsWithoutRef<"button">, "value" | "onChange" | "children"> &
  Pick<ButtonProps, "size" | "appearance"> & {
    value: string | number;
    options: readonly MenuOption[];
    placeholder?: string;
    onChange: (value: string) => void;
  }) {
  const selected = String(value);
  const option = options.find((item) => String(item.value) === selected);
  return (
    <Menu
      checkedValues={{ selection: option ? [selected] : [] }}
      onCheckedValueChange={(_, data) => {
        if (data.checkedItems[0] !== undefined) onChange(data.checkedItems[0]);
      }}
      positioning={{
        position: "below",
        align: "start",
        autoSize: true,
        matchTargetSize: "width",
      }}
    >
      <MenuTrigger disableButtonEnhancement>
        <Button
          as="button"
          {...props}
          type="button"
          className={`menu-select ${className}`}
          data-value={selected}
          icon={<ChevronDown16Regular />}
          iconPosition="after"
        >
          <span className="menu-select-label">
            <span className="menu-select-value">
              {option?.label ?? placeholder}
            </span>
            {placeholder && (
              <span
                className="menu-select-option-width"
                aria-hidden="true"
                data-label={placeholder}
              />
            )}
            {options.map((item) => (
              <span
                key={item.value}
                className="menu-select-option-width"
                aria-hidden="true"
                data-label={item.label}
              />
            ))}
          </span>
        </Button>
      </MenuTrigger>
      <MenuPopover className="selection-menu">
        <MenuList
          aria-label={
            props["aria-label"] ? `${props["aria-label"]}选项` : undefined
          }
        >
          {options.map((item) => (
            <MenuItemRadio
              key={item.value}
              name="selection"
              value={String(item.value)}
              data-value={String(item.value)}
              disabled={item.disabled}
            >
              {item.label}
            </MenuItemRadio>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
