interface Props {
  height?: string;
}

export default function LoadingState({
  height = 'h-48',
}: Props) {
  return (
    <div
      className={`flex items-center justify-center ${height}`}
    >
      <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}