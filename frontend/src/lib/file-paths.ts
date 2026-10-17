// One pure contract for rendered local paths and retained source discovery.
export {
  FILE_SCHEME,
  isTelosArtifactUrl,
  telosDocumentUrl,
  artifactApiUrl,
  artifactViewerUrl,
  relativeArtifactPath,
  absoluteMarkdownArtifactPath,
  remarkLocalMarkdownLinks,
  linkedArtifactPath,
  decodeFilePathUrl,
  remarkNeutralizeMalformedFileLinks,
  isFilePath,
  detectFilePaths,
  linkifyFilePaths,
  type FilePathMatch,
} from '@mitzo/protocol';
