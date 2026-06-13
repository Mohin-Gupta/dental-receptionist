import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-gray-900">Smile Dental Clinic</h1>
          <p className="text-gray-500 text-sm mt-1">Admin Portal</p>
        </div>
        <SignIn />
      </div>
    </div>
  );
}