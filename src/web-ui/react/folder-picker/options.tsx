import * as React from "react";
import { Empty, Flex, List, Spin, Typography } from "antd";
import { WandButton } from "../ui";
import type { FolderPickerItem } from "./types";

/** Shared directory list; both dialogs retain their own navigation and commit lifecycle. */
export function FolderPickerOptions({ id, optionPrefix, items, loading, error, activeIndex, itemRefs, onActivate, onActiveIndex }: {
  id: string;
  optionPrefix: string;
  items?: ReadonlyArray<FolderPickerItem>;
  loading: boolean;
  error: string;
  activeIndex: number;
  itemRefs: React.MutableRefObject<Array<HTMLButtonElement | null>>;
  onActivate(item: FolderPickerItem): void;
  onActiveIndex(index: number): void;
}): React.ReactElement {
  return <div id={id} role="listbox" aria-label="目录建议" style={{ maxHeight: "min(310px, 42dvh)", overflow: "auto" }}>
    {loading ? <Spin tip="正在加载目录…"><div style={{ minHeight: 112 }} role="status">正在加载目录…</div></Spin>
      : items?.length ? <List size="small" dataSource={[...items]} renderItem={(item, index) => <List.Item key={`${item.type}:${item.path}`}>
        <WandButton kind={activeIndex === index ? "soft" : "ghost"}
          ref={(element) => { itemRefs.current[index] = element; }} id={`${optionPrefix}-${index}`}
          type="button" role="option" aria-selected={activeIndex === index}
          style={{ width: "100%", height: "auto", justifyContent: "flex-start" }}
          onMouseEnter={() => onActiveIndex(index)} onClick={() => onActivate(item)}>
          <Flex gap={8} align="center" style={{ minWidth: 0, width: "100%" }}>
            <span aria-hidden="true">{item.type === "parent" ? "↩" : "▸"}</span>
            <Flex vertical style={{ minWidth: 0 }}>
              <Typography.Text strong ellipsis>{item.type === "parent" ? "..（返回上级目录）" : item.name}</Typography.Text>
              <Typography.Text type="secondary" ellipsis title={item.path}>{item.path}</Typography.Text>
            </Flex>
          </Flex>
        </WandButton>
      </List.Item>}/>
      : error ? null : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前目录没有子目录。"/>}
  </div>;
}
