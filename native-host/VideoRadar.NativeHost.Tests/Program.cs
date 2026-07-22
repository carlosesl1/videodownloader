using VideoRadar.NativeHost.Tests;

try
{
    TestSuite.RunAll();
    Console.WriteLine("Native host tests passed");
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine(error);
    return 1;
}
