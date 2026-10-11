package kz.luxar.finance;

import java.util.Arrays;
import java.util.Base64;

public class ChunkedFileTest {
    private static void reject(Runnable operation){
        try{operation.run();}catch(IllegalArgumentException expected){if(expected.getMessage().length()>120)throw new AssertionError("Payload leaked");return;}
        throw new AssertionError("Invalid transfer accepted");
    }
    public static void main(String[] args){
        byte[] bytes=new byte[250003];for(int i=0;i<bytes.length;i++)bytes[i]=(byte)i;
        bytes[0]=80;bytes[1]=75;bytes[2]=3;bytes[3]=4;
        String base64=Base64.getEncoder().encodeToString(bytes);
        ChunkedFile file=new ChunkedFile("statement.xlsx",ChunkedFile.XLSX,base64.length());
        reject(()->file.finish(file.id));
        reject(()->file.append("wrong",0,base64.substring(0,4000)));
        reject(()->file.append(file.id,1,base64.substring(0,4000)));
        reject(()->file.append(file.id,0,base64.substring(0,4004)));
        for(int start=0,index=0;start<base64.length();start+=4000,index++)file.append(file.id,index,base64.substring(start,Math.min(start+4000,base64.length())));
        if(!Arrays.equals(bytes,file.finish(file.id)))throw new AssertionError("Bytes changed");
        reject(()->new ChunkedFile("file","text/html",4));
        reject(()->new ChunkedFile("file","text/csv",16000004));
        reject(()->new ChunkedFile("file","text/csv",5));
        ChunkedFile invalid=new ChunkedFile("file.xlsx",ChunkedFile.XLSX,4);
        invalid.append(invalid.id,0,"YWJj");reject(()->invalid.finish(invalid.id));
        ChunkedFile shortFile=new ChunkedFile("file.csv","text/csv",8);
        reject(()->shortFile.append(shortFile.id,0,"YQ=="));
        reject(()->shortFile.append(shortFile.id,0,"!bad"));
        String csv="Счёт 🧾;902700\r\n";String encoded=Base64.getEncoder().encodeToString(csv.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        ChunkedFile unicode=new ChunkedFile("file.csv","text/csv",encoded.length());unicode.append(unicode.id,0,encoded);
        if(!csv.equals(new String(unicode.finish(unicode.id),java.nio.charset.StandardCharsets.UTF_8)))throw new AssertionError("Unicode changed");
        System.out.println("Native chunk transfer: all checks passed");
    }
}
