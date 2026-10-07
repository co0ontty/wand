export const imageViewerStyles = String.raw`
/* Transparency drawing and intrinsic image fit/100% zoom are viewer contracts. */
.wand-media-stage.ant-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: 100%;
  padding: 12px;
  overflow: auto;
  white-space: normal;
  background-image: linear-gradient(45deg, var(--bg-tertiary) 25%, transparent 25%), linear-gradient(-45deg, var(--bg-tertiary) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--bg-tertiary) 75%), linear-gradient(-45deg, transparent 75%, var(--bg-tertiary) 75%);
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  background-size: 16px 16px;
  cursor: zoom-in;
}
.wand-media-stage .ant-image { display: flex; max-width: 100%; max-height: 100%; }
.wand-media-stage img { max-width: 100%; max-height: 100%; object-fit: contain; }
.wand-media-stage.zoomed { align-items: flex-start; justify-content: flex-start; cursor: zoom-out; }
.wand-media-stage.zoomed .ant-image,
.wand-media-stage.zoomed img { max-width: none; max-height: none; }
`;
